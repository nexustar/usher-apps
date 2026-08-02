// Shortens a string for a label that must not grow unbounded, marking the cut.
export function ellipsize(value, limit) {
  const text = String(value || '');
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
