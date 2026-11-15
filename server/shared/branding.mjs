export const DEFAULT_ROOM = 'HeavyMP';
export const WEBSOCKET_PATH = '/heavymp';
// Previous room names remain readable so existing private configurations survive the rename.
const LEGACY_ROOM = 'OGMP';
export function canonicalRoom(value) {
  if (value == null) return DEFAULT_ROOM;
  return typeof value === 'string' && [LEGACY_ROOM, DEFAULT_ROOM.toUpperCase()].includes(value.toUpperCase())
    ? DEFAULT_ROOM : value;
}
