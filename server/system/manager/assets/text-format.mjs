export function formatText(text, values = {}) {
  return text.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
}
