import {readJson} from './storage.mjs';

const origin = 'https://steamcommunity.com';
const steamIdPattern = /^\d{17}$/;
const profilePath = /^\/(?:profiles\/\d{17}|id\/[\w-]{1,128})\/?$/;
const avatarHosts = new Set([
  'avatars.steamstatic.com',
  'avatars.akamai.steamstatic.com',
  'avatars.fastly.steamstatic.com',
  'steamcdn-a.akamaihd.net',
]);
const xmlEntities = {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};

function readField(xml, tag) {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  const value = match?.[1].trim() ?? '';
  if (value.startsWith('<![CDATA[') && value.endsWith(']]>')) return value.slice(9, -3);
  if (value.includes('<')) return '';
  return decodeEntities(value);
}

function decodeEntities(value) {
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/g, (_, entity) => {
    if (!entity.startsWith('#')) return xmlEntities[entity];
    const code = entity.startsWith('#x') ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
  });
}

function avatarUrl(value) {
  const url = URL.parse(value);
  if (url?.protocol !== 'https:' || !avatarHosts.has(url.hostname) || url.username || url.password
      || url.port || url.search || url.hash) return null;
  if (!/^\/(?:steamcommunity\/public\/images\/avatars\/[a-f0-9]{2}\/)?[a-f0-9]{40}(?:_medium|_full)?\.jpg$/i.test(url.pathname)) return null;
  return url.href;
}

function displayName(value) {
  if (typeof value !== 'string') return '';
  return Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').trim()).slice(0,64).join('');
}

export async function loadSteamProfiles(file) {
  const config = await readJson(file,{schema:1,profiles:{}},128 * 1024);
  if (config?.schema !== 1 || !config.profiles || typeof config.profiles !== 'object' || Array.isArray(config.profiles)) throw Error('Invalid manager-profiles.json.');
  const entries = Object.entries(config.profiles);
  if (entries.length > 256) throw Error('Too many saved Steam profiles.');
  return new Map(entries.map(([id, saved]) => {
    const name = displayName(saved?.name), avatar = avatarUrl(saved?.avatar ?? '');
    if (!steamIdPattern.test(id) || !name || (saved.avatar != null && !avatar)) throw Error('Invalid saved Steam profile.');
    return [id,{name,avatar}];
  }));
}

async function readProfileBody(url, {fetchImpl, signal, kind, limit, redirects = 0}) {
  const accept = kind === 'XML' ? 'application/xml, text/xml' : 'text/html';
  for (let hop = 0; ; hop++) {
    const response = await fetchImpl(url.href,{redirect:'manual',signal,headers:{accept}});
    if ([301,302,303,307,308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      const next = location && URL.parse(location,url);
      if (hop >= redirects || next?.origin !== origin || next.username || next.password
          || !profilePath.test(next.pathname) || next.search || next.hash) throw Error('unexpected redirect');
      url = next;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw Error('HTTP '+response.status);
    }
    const type = (response.headers.get('content-type') ?? '').split(';',1)[0].trim().toLowerCase();
    if (!response.body || !accept.split(', ').includes(type)) {
      await response.body?.cancel();
      throw Error('unexpected response type');
    }
    const decoder = new TextDecoder();
    let text = '', size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > limit) throw Error('response too large');
      text += decoder.decode(chunk,{stream:true});
    }
    return text + decoder.decode();
  }
}

function readXmlProfile(xml,steamId) {
  if (!/^(?:<\?xml[^?]*\?>\s*)?<profile>\s*<steamID64>/.test(xml.trimStart())
      || readField(xml,'steamID64') !== steamId) throw Error('profile ID missing or different');
  return {
    name:displayName(readField(xml,'steamID')),
    avatar:avatarUrl(readField(xml,'avatarMedium')) ?? avatarUrl(readField(xml,'avatarIcon')),
  };
}

function readHtmlProfile(html,steamId) {
  const raw = /^\s*(?:var\s+)?g_rgProfileData\s*=\s*(\{[^\r\n]+\});/m.exec(html)?.[1];
  if (!raw) throw Error('profile data missing');
  let data;
  try { data = JSON.parse(raw); } catch { throw Error('invalid profile data'); }
  if (data?.steamid !== steamId) throw Error('profile ID missing or different');
  const image = /<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i.exec(html)?.[1] ?? '';
  return {name:displayName(data.personaname),avatar:avatarUrl(decodeEntities(image))};
}

function failureReason(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timeout';
  const code = error?.cause?.code ?? error?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code)) return code;
  if (/^(HTTP \d{3}|unexpected redirect|unexpected response type|response too large|profile ID missing or different|profile data missing|invalid profile data)$/.test(error?.message)) return error.message;
  return 'request failed';
}

// OpenID verifies identity. Public and saved profiles are only used for display.
export async function steamProfile(steamId, fetchImpl = fetch, {saved, report = ()=>{}} = {}) {
  const result = {steamId,name:'',avatar:null};
  if (!steamIdPattern.test(steamId)) return {...result,name:'Steam user'};
  const diagnostics = [];
  const update = async (kind,path,parse,options) => {
    try {
      const url = new URL(path,origin);
      const text = await readProfileBody(url,{fetchImpl,kind,...options});
      const profile = parse(text,steamId);
      result.name ||= profile.name;
      result.avatar ??= profile.avatar;
      if (!profile.name || !profile.avatar) diagnostics.push(kind+': incomplete profile');
    } catch (error) {
      diagnostics.push(kind+': '+failureReason(error));
    }
  };

  await update('XML','/profiles/'+steamId+'?xml=1',readXmlProfile,{
    signal:AbortSignal.timeout(2400),limit:128 * 1024,
  });
  if (!result.name || !result.avatar) await update('HTML','/profiles/'+steamId+'/',readHtmlProfile,{
    signal:AbortSignal.timeout(3200),limit:512 * 1024,redirects:2,
  });
  if (!result.name || !result.avatar) {
    const restored = Boolean((!result.name && saved?.name) || (!result.avatar && saved?.avatar));
    result.name ||= saved?.name || 'Steam user';
    result.avatar ??= saved?.avatar ?? null;
    report('Steam profile '+(restored?'using saved display details':'incomplete')+' ('+diagnostics.join('; ')+').');
  }
  return result;
}
