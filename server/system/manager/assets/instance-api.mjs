export let selectedInstance = new URLSearchParams(location.search).get('instance');

export function setInstance(id) { selectedInstance = id; }

export function managerApi(path, instance = selectedInstance) {
 const url = new URL('/manager/api/'+path,location.origin);
 if(instance!==null&&path!=='logout')url.searchParams.set('instance',instance);
 return url.pathname+url.search;
}
