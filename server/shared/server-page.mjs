export const SERVER_PAGE_PATH='/manager/api/public/v1/server-page';
export const SERVER_PAGE_MAX_BYTES=128*1024;

function text(value,limit){
 if(value===undefined)return '';
 if(typeof value!=='string'||Buffer.byteLength(value)>limit||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))throw Error('invalid_server_page');
 return value.trim();
}

function link(value,hosts){
 const raw=text(value,512);
 if(!raw)return '';
 if(/[\u0000-\u001f\u007f]/.test(raw))throw Error('invalid_server_page');
 const url=URL.parse(raw);
 if(url?.protocol!=='https:'||url.username||url.password||url.href.length>512||
    (hosts&&!hosts.includes(url.hostname)))throw Error('invalid_server_page');
 return url.href;
}

export function serverPage(value={}){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid_server_page');
 return {
  schema:1,
  description:text(value.description,2000),
  bannerUrl:link(value.bannerUrl),
  websiteUrl:link(value.websiteUrl),
  discordUrl:link(value.discordUrl,['discord.gg','discord.com','www.discord.com']),
  whatsappUrl:link(value.whatsappUrl,['chat.whatsapp.com','wa.me','api.whatsapp.com','www.whatsapp.com','whatsapp.com']),
  html:text(value.html,24*1024),
  css:text(value.css,8*1024),
 };
}
