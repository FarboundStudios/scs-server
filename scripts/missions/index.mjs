import routes from './routes.json' with {type: 'json'};

const presets = routes && typeof routes === 'object' && !Array.isArray(routes) ? routes : {};
const aliasPattern = /^[a-z0-9][a-z0-9-]{0,23}$/;
const createHelp = '/script missions new <public|private> <source> <destination> <cargo> <trailer> <units> <km> [title]';

export function onCommand({args}) {
  const [action, ...values] = args;
  if (action === 'list') {
    const aliases = Object.keys(presets).filter(alias => aliasPattern.test(alias)).sort();
    if (!aliases.length) return 'No presets yet. Add routes to scripts/missions/routes.json or use /script missions new.';
    const page = Number(values[0] ?? 1);
    const pageCount = Math.ceil(aliases.length / 6);
    if (!Number.isInteger(page) || page < 1 || page > pageCount) return 'Use /script missions list <1–' + pageCount + '>.';
    return 'Mission presets (' + page + '/' + pageCount + '): ' + aliases.slice((page - 1) * 6, page * 6).join(', ');
  }
  if (action === 'create') {
    const [alias] = values;
    if (values.length !== 1 || !aliasPattern.test(alias) || !Object.hasOwn(presets, alias)) {
      return 'Choose a preset with /script missions list, then use /script missions create <preset>.';
    }
    const mission = presets[alias];
    if (!mission || typeof mission !== 'object' || Array.isArray(mission)) return 'This preset has an invalid configuration.';
    return {mission};
  }
  if (action === 'new') {
    const [visibility, source, destination, cargo, trailerDefinition, units, distance, ...words] = values;
    if (!['public', 'private'].includes(visibility) || !source || !destination || !cargo || !trailerDefinition ||
        !/^\d{1,5}$/.test(units ?? '') || !/^\d{1,5}$/.test(distance ?? '')) return createHelp;
    const title = words.join(' ') || (source + ' → ' + destination).slice(0, 80);
    return {mission: {title, visibility, source, destination, cargo, trailerDefinition, unitsCount: Number(units), distanceKm: Number(distance)}};
  }
  return 'Use /script missions list, /script missions create <preset> or /script missions new for a custom route.';
}
