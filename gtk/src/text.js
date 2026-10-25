// Shortens a string for a label that must not grow unbounded, marking the cut.
export function ellipsize(value, limit) {
  const text = String(value || '');
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

// formatArgs and parseArgs move CLI flags between an argv array and one line
// of shell-style text, keeping empty arguments: ['--tools', ''] is
// `--tools ''`.
export function formatArgs(args) {
  return (args || []).map(a =>
    /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, '\'\\\'\'')}'`
  ).join(' ');
}

// Single quotes are literal; in double quotes and bare text a backslash
// escapes the next character. An unclosed quote throws.
export function parseArgs(text) {
  const args = [];
  let cur = '', inArg = false, quote = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === '\'') {
      if (c === '\'') quote = ''; else cur += c;
    } else if (c === '\\' && i + 1 < text.length && (!quote || '"\\'.includes(text[i + 1]))) {
      cur += text[++i];
      inArg = true;
    } else if (quote === '"') {
      if (c === '"') quote = ''; else cur += c;
    } else if (c === '\'' || c === '"') {
      quote = c;
      inArg = true;
    } else if (/\s/.test(c)) {
      if (inArg) args.push(cur);
      cur = '';
      inArg = false;
    } else {
      cur += c;
      inArg = true;
    }
  }
  if (quote) throw new Error(`Unclosed ${quote} in flags`);
  if (inArg) args.push(cur);
  return args;
}
