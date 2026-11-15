// Shared English connection and moderation messages for the launcher and client.
/** Refus qui arrêtent les tentatives automatiques (une action du joueur ou de l'équipe est nécessaire). */
export const FATAL_REFUSALS = new Set(['banned', 'kicked', 'update_required','staff_only','staff_vehicle_required','map_module_mismatch']);

const utc = value => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
};

/**
 * @param {{ code: string, scope?: string, until?: string|null, reason?: string|null }} refusal
 * @returns {string}
 */
export function describeRefusal({ code, until, reason } = {}) {
  const why = typeof reason === 'string' && reason.trim() ? ` Reason: ${reason.trim().slice(0, 200)}.` : '';
  const end = until && utc(until);
  switch (code) {
    case 'banned':
      return 'You are banned from this server'+(end?' until '+end:'')+'.'+why;
    case 'kicked': return `You were kicked from the server.${why}`;
    case 'update_required': return 'This server requires a compatible launcher version.';
    case 'staff_only': return 'This server is restricted to this server’s staff.';
    case 'staff_vehicle_required': return 'This vehicle is restricted to this server’s staff. Select a truck or a standard escort vehicle before reconnecting.';
    case 'server_busy': return 'Server busy. Retrying automatically…';
    case 'identity_in_use': return 'This profile is already connected. Close the other launcher.';
    case 'access_denied': return 'Access denied by the server.';
    case 'map_module_mismatch': return 'This server requires a different ETS2 map module. Start HeavyMP with the correct career and an up-to-date launcher.';
    case 'map_mismatch': return 'Map mismatch. Update HeavyMP and restart ETS2 from the launcher.';
    case 'game_version': return 'Game version not compatible with the server.';
    case 'name': return 'Name rejected by the server.';
    case 'name_taken': return 'This name is already in use on the server.';
    case 'protocol': return 'Launcher version not compatible with the server.';
    case 'room_full': return 'The server is full.';
    default: return `Server: ${code}`;
  }
}
