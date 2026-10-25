import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import './promises.js';

const API = '/api/v1';

// usher answers { error: { code, message } }; anything else falls back to the
// status.
function errorMessage(payload, status) {
  const error = payload?.error;
  return error?.message || (typeof error === 'string' ? error : '') || `HTTP ${status}`;
}

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

  // Archived roots and read-only subagents come along; the sidebar decides
  // what to show, the way the web client does.
  async listSessions() {
    const list = await this.request('GET', `${API}/sessions?include_archived=1&include_subagents=1`);
    return list?.sessions || [];
  }

  // Every field but the message is optional; an agent profile supplies the
  // defaults for whatever is left out.
  createSession({ cwd, initialMessage, model, effort, backend, agent, approval }) {
    const body = { initial_message: initialMessage || '' };
    if (agent) body.agent = agent;
    if (cwd !== undefined) body.cwd = cwd;
    if (backend) body.backend = backend;
    if (model) body.model = model;
    if (effort) body.effort = effort;
    if (approval) body.approval = approval;
    return this.request('POST', `${API}/sessions`, body);
  }

  // { backends: [name], models: { backend: [{id, display_name, alias,
  // thinking_levels}] }, approvals: { backend: [approval] } }
  async listBackends() {
    const list = (await this.request('GET', `${API}/backends`))?.backends || [];
    return {
      backends: list.map(b => b.name),
      models: Object.fromEntries(list.map(b => [b.name, b.models || []])),
      approvals: Object.fromEntries(list.map(b => [b.name, b.approvals || []])),
    };
  }

  // { editor_url, read_only, router: {session_id, dir} }
  getConfig() {
    return this.request('GET', '/internal/config');
  }

  // { source, available, commands: [{name, kind, description}] }. Only trust
  // commands when available is true; a backend that cannot answer says so
  // rather than reporting an empty catalog.
  listCommands(id) {
    return this.request('GET', `${API}/sessions/${encodeURIComponent(id)}/commands`);
  }

  // Starts an idle worker without adding a user turn.
  resumeSession(id) {
    return this.request('POST', `${API}/sessions/${encodeURIComponent(id)}/resume`);
  }

  listAgents() {
    return this.request('GET', `${API}/agents`);
  }

  createAgent(profile) {
    return this.request('POST', `${API}/agents`, profile);
  }

  updateAgent(name, profile) {
    return this.request('PUT', `${API}/agents/${encodeURIComponent(name)}`, profile);
  }

  // Deleting the default agent puts the built-in one back.
  deleteAgent(name) {
    return this.request('DELETE', `${API}/agents/${encodeURIComponent(name)}`);
  }

  // { schedules: [task + next_run], timezone }
  listSchedules() {
    return this.request('GET', `${API}/schedules`);
  }

  createSchedule(task) {
    return this.request('POST', `${API}/schedules`, task);
  }

  updateSchedule(id, task) {
    return this.request('PUT', `${API}/schedules/${encodeURIComponent(id)}`, task);
  }

  deleteSchedule(id) {
    return this.request('DELETE', `${API}/schedules/${encodeURIComponent(id)}`);
  }

  runSchedule(id) {
    return this.request('POST', `${API}/schedules/${encodeURIComponent(id)}/run`);
  }

  getSession(id) {
    return this.request('GET', `${API}/sessions/${encodeURIComponent(id)}`);
  }

  // A page of a session's turns, oldest first: the newest `limit`, the page
  // ahead of cursor `before`, or the turn at cursor `from` and everything after
  // it. `more` says older turns exist ahead of the first one.
  async getTranscript(id, { limit = 100, before = '', from = '' } = {}) {
    const query = from
      ? `?from=${encodeURIComponent(from)}`
      : `?limit=${limit}` + (before ? `&before=${encodeURIComponent(before)}` : '');
    const page = await this.request(
      'GET', `${API}/sessions/${encodeURIComponent(id)}/transcript${query}`);
    return { turns: page?.turns || [], more: Boolean(page?.has_more) };
  }

  fork(id, afterUUID) {
    return this.request('POST', `${API}/sessions/${encodeURIComponent(id)}/fork`, { after_uuid: afterUUID });
  }

  // Raw bytes of an image referenced by this session's transcript. The server
  // resolves the path against the session cwd (plus its attachment and
  // generated-image directories) and refuses anything outside them.
  async imageBytes(id, path) {
    const message = Soup.Message.new(
      'GET',
      `${this.baseUrl}${API}/sessions/${encodeURIComponent(id)}/image` +
        `?path=${encodeURIComponent(path)}`
    );
    const bytes = await this._sendAndRead(message);
    if (message.status_code < 200 || message.status_code >= 300) {
      throw new ApiError(message.status_code, `HTTP ${message.status_code}`);
    }
    return bytes;
  }

  send(id, text) {
    return this.request('POST', `${API}/sessions/${encodeURIComponent(id)}/messages`, { text });
  }

  cancel(id) {
    return this.request('POST', `${API}/sessions/${encodeURIComponent(id)}/interrupt`);
  }

  // title, archived, pinned, approval, model, effort, extra_args; omitted
  // fields stay as they are.
  patchSession(id, fields) {
    return this.request('PATCH', `${API}/sessions/${encodeURIComponent(id)}`, fields);
  }

  renameSession(id, title) {
    return this.patchSession(id, { title });
  }

  setArchived(id, archived) {
    return this.patchSession(id, { archived });
  }

  setPinned(id, pinned) {
    return this.patchSession(id, { pinned });
  }

  // Uploads into a session's attachment directory, or — with a null id — into
  // the shared drafts directory, which is how a file can be attached to a
  // session that does not exist yet.
  upload(id, filename, contentType, bytes) {
    const query = `?filename=${encodeURIComponent(filename)}` +
      (id === null ? '' : `&session_id=${encodeURIComponent(id)}`);
    return this.request('POST', `${API}/uploads${query}`, null, null,
      { contentType: contentType || 'application/octet-stream', bytes });
  }

  pauseSession(id) {
    return this.request('POST', `${API}/sessions/${encodeURIComponent(id)}/pause`);
  }

  async listInteractions() {
    return (await this.request('GET', `${API}/interactions`))?.interactions || [];
  }

  // response: { behavior: 'allow'|'deny', scope?: 'once'|'always',
  //             reason?: string, answers?: {question: label} }
  respondInteraction(id, response) {
    return this.request(
      'POST',
      `${API}/interactions/${encodeURIComponent(id)}/respond`,
      response
    );
  }

  deleteSession(id) {
    return this.request('DELETE', `${API}/sessions/${encodeURIComponent(id)}`);
  }

  eventsUrl(id) {
    return `${this.baseUrl}${API}/sessions/${encodeURIComponent(id)}/events`;
  }

  // raw sends { contentType, bytes } as the body instead of JSON.
  async request(method, path, body = null, cancellable = null, raw = null) {
    const message = Soup.Message.new(method, `${this.baseUrl}${path}`);
    if (raw) {
      message.set_request_body_from_bytes(raw.contentType, raw.bytes);
    } else if (body !== null) {
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
      throw new ApiError(message.status_code, errorMessage(payload, message.status_code));
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
