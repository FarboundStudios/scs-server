import {createHash} from 'node:crypto';

export const MAX_OPTIONAL_SLOTS = 100;
export const MAX_ADDON_ORDER_BYTES = 384 * 1024;
export const MAX_OPTIONAL_DOWNLOAD_URL = 512;
const archivePattern = /^[\p{L}\p{N}][^/\\:\u0000-\u001f\u007f]{0,179}\.(?:scs|zip)$/iu;
const localPattern = /^[\p{L}\p{N}][^/\\:\u0000-\u001f\u007f]{0,183}$/u;
export const optionalKey = (source, match) => source + ':' + match.toLowerCase();

function optionalDownloadUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_OPTIONAL_DOWNLOAD_URL || /[\u0000-\u001f\u007f]/.test(value)) throw Error('invalid_optional_order');
  const url = URL.parse(value.trim());
  if (url?.protocol !== 'https:' || url.username || url.password || url.href.length > MAX_OPTIONAL_DOWNLOAD_URL) throw Error('invalid_optional_order');
  return url.href;
}

export function optionalSlots(value) {
  if (!Array.isArray(value) || value.length > MAX_OPTIONAL_SLOTS) throw Error('invalid_optional_order');
  const seen = new Set();
  return value.map(slot => {
    if (!slot || typeof slot !== 'object' || typeof slot.name !== 'string' ||
        typeof slot.match !== 'string' || (slot.after !== null &&
        (typeof slot.after !== 'string' || !archivePattern.test(slot.after)))) throw Error('invalid_optional_order');
    const name = slot.name.trim();
    const match = slot.match.trim();
    const validMatch = slot.source === 'workshop' ? /^[1-9][0-9]{0,19}$/.test(match) :
      slot.source === 'local' && localPattern.test(match) && !/[. ]$/.test(match);
    if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name) ||
        !validMatch || seen.has(optionalKey(slot.source, match))) throw Error('invalid_optional_order');
    seen.add(optionalKey(slot.source, match));
    if (slot.downloadUrl!==undefined&&slot.source!=='local') throw Error('invalid_optional_order');
    return {name,source:slot.source,match,after:slot.after,
      ...(slot.downloadUrl===undefined?{}:{downloadUrl:optionalDownloadUrl(slot.downloadUrl)}),
    };
  });
}

export function describeOptionalOrder(slots, mapRevision) {
  const layout = optionalSlots(slots);
  const placement = layout.map(({name,source,match,after})=>({name,source,match,after}));
  const revision = createHash('sha256').update(JSON.stringify({mapRevision,slots:placement})).digest('hex');
  return {revision, slots: layout};
}
