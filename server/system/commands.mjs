// In-game staff commands granted by the local allowlist.
import { randomUUID } from 'node:crypto';
import { normalizeAnnouncement } from './announcements.mjs';

const REFUSALS = {insufficient_rank:'You can only moderate players of a lower rank.',self:'You cannot moderate yourself.'};

/** Découpe « "Mateo - Z3K.dev" 30m motif… » ou « pseudo 30m motif… » → { target, rest }. */
export function splitTarget(text) {
  const raw = String(text ?? '').trim();
  if (raw.startsWith('"')) {
    const end = raw.indexOf('"', 1);
    return end < 0 ? { target: raw.slice(1), rest: '' } : { target: raw.slice(1, end), rest: raw.slice(end + 1).trim() };
  }
  const [target = '', ...others] = raw.split(/\s+/);
  return { target, rest: others.join(' ') };
}

/**
 * @param {{ sessions: Map<string, any>, moderation: {can: Function, priority: Function}, kick: Function,
 *           tell: (session: any, text: string) => void, announce: (text: string) => void, depots?: Record<string, {x:number,y:number,z:number,heading?:number}>,
 *           now?: () => number }} options
 */
export function createCommands({ sessions, moderation, kick, tell, announce, depots = {}, now = Date.now }) {
  const online = () => [...sessions.values()];
  const findOnline = target => online().find(s => s.id === target || s.name.toLowerCase() === target.toLowerCase());
  const fresh = s => s.lastState && performance.now() - s.stateAt < 3000;

  /** Joueur ciblé : en ligne, différent de soi, de rang strictement inférieur. Renvoie la session ou null (après avoir répondu). */
  function lowerOnlineTarget(actor, target) {
    if (!target) { tell(actor, 'Enter a player name (use quotes if it contains spaces) or SteamID.'); return null; }
    const found = findOnline(target);
    if (!found) { tell(actor, `Player "${target.slice(0, 40)}" is not online.`); return null; }
    if (found === actor) { tell(actor, REFUSALS.self); return null; }
    if (moderation.priority(found) >= moderation.priority(actor)) { tell(actor, REFUSALS.insufficient_rank); return null; }
    return found;
  }

  /** Envoie au client une action physique (téléportation). Refusée si son plugin ne la gère pas. */
  function sendAction(to, action, payload, actor, label) {
    if (!to.supportsTeleport) { tell(actor, `${label} : ${to.name}'s plugin does not support teleporting. A launcher update is required.`); return false; }
    const id = randomUUID();
    to.teleportId = id; to.teleportAt = now();
    if (action === 'teleport') to.teleportTarget = { ...payload, until: performance.now() + 15000 };
    to.socket.write(JSON.stringify({ type: 'action', action, id, ...payload }) + '\n');
    return true;
  }
  const position = s => ({ x: s.lastState.x, y: s.lastState.y, z: s.lastState.z, heading: s.lastState.heading });

  const handlers = {
    announce: { permission: 'game.announce', run(s, args, rest) {
      const text = normalizeAnnouncement(rest);
      if (!text) return tell(s, 'Usage: /announce message (up to 240 characters).');
      announce(text);
    } },
    kick: { permission: 'game.kick', run(s, args, rest) {
      const { target, rest: reason } = splitTarget(rest);
      const found = lowerOnlineTarget(s, target);
      if (!found) return;
      kick(found, 'kicked', { reason: reason.slice(0, 200) || null });
      announce(`${found.name} was kicked by ${s.name}${reason ? ' : ' + reason.slice(0, 120) : ''}.`);
    } },
    tp: { permission: 'game.developer', run(s, args, rest) {
      const found = findOnline(splitTarget(rest).target);
      if (!found || found === s) return tell(s, 'Usage: /tp player (another online player).');
      if (!fresh(found)) return tell(s, `${found.name} is not in driving mode.`);
      if (sendAction(s, 'teleport', position(found), s, '/tp')) tell(s, `Teleporting to ${found.name}…`);
    } },
    bring: { permission: 'game.move', run(s, args, rest) {
      const found = lowerOnlineTarget(s, splitTarget(rest).target);
      if (!found) return;
      if (!fresh(s) || !fresh(found)) return tell(s, 'Both players must be in driving mode.');
      if (sendAction(found, 'teleport', position(s), s, '/bring')) tell(s, `${found.name} is being teleported to you.`);
    } },
    move: { permission: 'game.move', run(s, args, rest) {
      const { target, rest: depotName } = splitTarget(rest);
      const found = lowerOnlineTarget(s, target), depot = depots[depotName.trim().toLowerCase()];
      if (!found) return;
      if (!depot) return tell(s, Object.keys(depots).length ? `Unknown depot. Available depots: ${Object.keys(depots).slice(0, 15).join(', ')}.` : 'No depots are configured on this server.');
      if (sendAction(found, 'teleport', { x: depot.x, y: depot.y, z: depot.z, heading: depot.heading ?? 0 }, s, '/move')) tell(s, `${found.name} is being teleported to the "${depotName.trim()}" depot.`);
    } },
    prop: { permission: 'game.props', run(s) {
      // Réservé : la pose de props demande une prise en charge dans le plugin du jeu (non livrée dans cette version).
      tell(s, 'Prop placement is unavailable in this plugin version.');
    } },
  };

  return {
    /** Vrai si la commande existe (permission vérifiée ici : sans permission la commande est annoncée comme inconnue). */
    handle(session, command, args, rest) {
      const handler = handlers[command === 'annonce' ? 'announce' : command];
      if (!handler) return false;
      if (!moderation.can(session, handler.permission)) { tell(session, 'Unknown command. Use /help to list available commands.'); return true; }
      Promise.resolve(handler.run(session, args, rest)).catch(error => { tell(session, 'Command unavailable right now.'); console.error('Command /' + command + ' :', error.message); });
      return true;
    },
    /** Commandes de modération que cette session a le droit d'utiliser (pour /help). */
    available: session => Object.entries(handlers).filter(([, h]) => moderation.can(session, h.permission)).map(([name]) => '/' + name),
  };
}
