/** Shared validation for authenticated in-game staff and the local operator. */
export function normalizeAnnouncement(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  const text = value.normalize('NFC').trim();
  return text && text.length <= 240 ? text : null;
}
