import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

// GI async methods require callbacks by default. Promisify the small set used
// by the client so callers can await them consistently across GJS versions.
Gio._promisify(
  Soup.Session.prototype,
  'send_and_read_async',
  'send_and_read_finish'
);
Gio._promisify(
  Soup.Session.prototype,
  'send_async',
  'send_finish'
);
Gio._promisify(
  Gio.DataInputStream.prototype,
  'read_line_async',
  'read_line_finish'
);
Gio._promisify(
  Gio.Subprocess.prototype,
  'wait_async',
  'wait_finish'
);
Gio._promisify(
  Gio.File.prototype,
  'load_bytes_async',
  'load_bytes_finish'
);
