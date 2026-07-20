import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import './promises.js';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class ApiClient {
  constructor(baseUrl, requestTimeoutMs = 15000) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.requestTimeoutMs = requestTimeoutMs;
    this._createSession();
  }

  // The Soup session (and its cookie jar) survives server switches: the jar
  // keys cookies by host, so switching back to a server the user already
  // authenticated to keeps working for the lifetime of the process.
  setBaseUrl(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  _createSession() {
    // The SSE stream holds one connection per host open indefinitely; raise
    // the per-host limit so API requests never queue behind it (default 2).
    this.session = new Soup.Session({
      user_agent: 'usher-gtk/0.1',
      max_conns_per_host: 8,
    });
    this.cookieJar = new Soup.CookieJar();
    this.session.add_feature(this.cookieJar);
  }

  setAuthCookie(value) {
    const uri = GLib.Uri.parse(this.baseUrl, GLib.UriFlags.NONE);
    const cookie = Soup.Cookie.new('usher_auth', value, uri.get_host(), '/', -1);
    this.cookieJar.add_cookie(cookie);
  }

  async login(password) {
    const message = Soup.Message.new('POST', `${this.baseUrl}/login`);
    const form = `password=${encodeURIComponent(password)}&next=${encodeURIComponent('/')}`;
    message.set_request_body_from_bytes(
      'application/x-www-form-urlencoded',
      new GLib.Bytes(new TextEncoder().encode(form))
    );
    const bytes = await this._sendAndRead(message);
    if (message.status_code < 200 || message.status_code >= 400) {
      throw new ApiError(message.status_code, 'Incorrect password');
    }
    // A successful form POST sets the auth cookie. Verify it against an API
    // endpoint because Soup follows the redirect to the HTML shell.
    await this.listSessions();
    return bytes;
  }

  listSessions() {
    return this.request('GET', '/api/sessions?include_archived=1');
  }

  createSession(cwd, initialMessage, model = '') {
    return this.request('POST', '/api/sessions', {
      cwd,
      initial_message: initialMessage,
      model,
    });
  }

  getSession(id) {
    return this.request('GET', `/api/sessions/${encodeURIComponent(id)}`);
  }

  // Unlike request(), this needs the X-Transcript-Total response header (the
  // full turn count before the `limit` trim), so it cannot go through the
  // header-discarding generic path.
  async getTranscript(id, limit = 100) {
    const message = Soup.Message.new(
      'GET',
      `${this.baseUrl}/api/sessions/${encodeURIComponent(id)}/transcript?limit=${limit}`
    );
    const bytes = await this._sendAndRead(message);
    const text = new TextDecoder().decode(bytes.get_data());
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); }
      catch (_) { payload = text; }
    }
    if (message.status_code < 200 || message.status_code >= 300) {
      const detail = payload?.error || `HTTP ${message.status_code}`;
      throw new ApiError(message.status_code, detail);
    }
    const total = parseInt(message.get_response_headers().get_one('X-Transcript-Total') || '', 10);
    return { turns: payload || [], total: Number.isFinite(total) ? total : (payload || []).length };
  }

  fork(id, afterUUID) {
    return this.request('POST', `/api/sessions/${encodeURIComponent(id)}/fork`, { after_uuid: afterUUID });
  }

  send(id, text) {
    return this.request('POST', `/api/sessions/${encodeURIComponent(id)}/send`, { text });
  }

  cancel(id) {
    return this.request('DELETE', `/api/sessions/${encodeURIComponent(id)}/send`);
  }

  renameSession(id, title) {
    return this.request('POST', `/api/sessions/${encodeURIComponent(id)}/rename`, { title });
  }

  setArchived(id, archived) {
    return this.request(
      archived ? 'POST' : 'DELETE',
      `/api/sessions/${encodeURIComponent(id)}/archive`
    );
  }

  setPinned(id, pinned) {
    return this.request(
      pinned ? 'POST' : 'DELETE',
      `/api/sessions/${encodeURIComponent(id)}/pin`
    );
  }

  setAutoApprove(id, enabled) {
    return this.request(
      'POST',
      `/api/sessions/${encodeURIComponent(id)}/auto-approve`,
      { enabled }
    );
  }

  async upload(id, filename, contentType, bytes) {
    const message = Soup.Message.new(
      'POST',
      `${this.baseUrl}/api/sessions/${encodeURIComponent(id)}/upload`
    );
    const multipart = Soup.Multipart.new('multipart/form-data');
    multipart.append_form_file('file', filename, contentType || null, bytes);
    const body = multipart.to_message(message.request_headers);
    // to_message already set Content-Type including the boundary parameter;
    // passing a content type here would overwrite it with a bare one.
    message.set_request_body_from_bytes(null, body);
    const response = await this._sendAndRead(message);
    const text = new TextDecoder().decode(response.get_data());
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); }
      catch (_) { payload = text; }
    }
    if (message.status_code < 200 || message.status_code >= 300) {
      throw new ApiError(message.status_code, payload?.error || `HTTP ${message.status_code}`);
    }
    return payload;
  }

  pauseSession(id) {
    return this.request('POST', `/api/sessions/${encodeURIComponent(id)}/pause`);
  }

  listInteractions() {
    return this.request('GET', '/api/interactions');
  }

  // response: { behavior: 'allow'|'deny', scope?: 'once'|'session',
  //             reason?: string, answers?: {question: label} }
  respondInteraction(id, response) {
    return this.request(
      'POST',
      `/api/interactions/${encodeURIComponent(id)}/respond`,
      response
    );
  }

  deleteSession(id) {
    return this.request('DELETE', `/api/sessions/${encodeURIComponent(id)}`);
  }

  async request(method, path, body = null, cancellable = null) {
    const message = Soup.Message.new(method, `${this.baseUrl}${path}`);
    if (body !== null) {
      const encoded = new TextEncoder().encode(JSON.stringify(body));
      message.set_request_body_from_bytes('application/json', new GLib.Bytes(encoded));
    }

    const bytes = await this._sendAndRead(message, cancellable);

    const text = new TextDecoder().decode(bytes.get_data());
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); }
      catch (_) { payload = text; }
    }
    if (message.status_code < 200 || message.status_code >= 300) {
      const detail = payload?.error || `HTTP ${message.status_code}`;
      throw new ApiError(message.status_code, detail);
    }
    return payload;
  }

  async _sendAndRead(message, cancellable = null) {
    const operation = cancellable || new Gio.Cancellable();
    let timedOut = false;
    let timeoutId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      this.requestTimeoutMs,
      () => {
        timeoutId = 0;
        timedOut = true;
        operation.cancel();
        return GLib.SOURCE_REMOVE;
      }
    );
    try {
      return await this.session.send_and_read_async(
        message,
        GLib.PRIORITY_DEFAULT,
        operation
      );
    } catch (error) {
      throw new ApiError(
        0,
        timedOut ? `Request timed out after ${this.requestTimeoutMs / 1000}s` :
          (error.message || String(error))
      );
    } finally {
      if (timeoutId) GLib.source_remove(timeoutId);
    }
  }
}
