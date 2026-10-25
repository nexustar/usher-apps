import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import './promises.js';

export class EventStream {
  constructor(soupSession, url, onEvent, onState = null) {
    this._session = soupSession;
    this._url = url;
    this._onEvent = onEvent;
    this._onState = onState;
    this._cancellable = null;
    this._generation = 0;
  }

  start() {
    this.stop();
    this._cancellable = new Gio.Cancellable();
    const generation = ++this._generation;
    this._run(generation).catch(error => {
      if (!this._cancellable?.is_cancelled()) this._onState?.('error', error);
    });
  }

  stop() {
    this._generation++;
    this._cancellable?.cancel();
    this._cancellable = null;
  }

  async _run(generation) {
    let delay = 500;
    while (this._cancellable && generation === this._generation) {
      try {
        await this._connect(generation);
        delay = 500;
      } catch (error) {
        if (!this._cancellable || this._cancellable.is_cancelled()) return;
        this._onState?.('disconnected', error);
      }
      await this._wait(delay, generation);
      delay = Math.min(delay * 2, 5000);
    }
  }

  async _connect(generation) {
    const message = Soup.Message.new('GET', this._url);
    message.request_headers.append('Accept', 'text/event-stream');
    const stream = await this._session.send_async(
      message,
      GLib.PRIORITY_DEFAULT,
      this._cancellable
    );
    if (message.status_code !== Soup.Status.OK) {
      throw new Error(`Event stream returned HTTP ${message.status_code}`);
    }
    this._onState?.('connected');

    const data = new Gio.DataInputStream({ base_stream: stream });
    let eventName = 'message';
    let payloadLines = [];
    while (this._cancellable && generation === this._generation) {
      const [line] = await data.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable);
      if (line === null) throw new Error('Event stream closed');
      const value = new TextDecoder().decode(line);
      if (value === '') {
        if (payloadLines.length) {
          const raw = payloadLines.join('\n');
          // Frames are {session_id, type, data}.
          let payload;
          try { payload = JSON.parse(raw)?.data || {}; }
          catch (_) { payload = { raw }; }
          this._onEvent(eventName, payload);
        }
        eventName = 'message';
        payloadLines = [];
      } else if (value.startsWith('event:')) {
        eventName = value.slice(6).trimStart();
      } else if (value.startsWith('data:')) {
        payloadLines.push(value.slice(5).trimStart());
      }
    }
  }

  _wait(milliseconds, generation) {
    return new Promise(resolve => {
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
        resolve(generation === this._generation);
        return GLib.SOURCE_REMOVE;
      });
    });
  }
}
