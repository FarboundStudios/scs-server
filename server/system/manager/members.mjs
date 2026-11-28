import {join} from 'node:path';
import {STEAM_ID} from './config.mjs';
import {atomicJson,readJson,SerialStore} from './storage.mjs';

const common = ['overview','players','map','performance'];
const rolePages = {
 owner: [...common,'console','logs','chat','moderation','addons','scripts','backups','automation','audit','settings','help','access','instances'],
 administrator: [...common,'console','logs','chat','moderation','addons','scripts','backups','automation','audit','settings','help'],
 operator: [...common,'console','logs'],
 moderator: [...common,'chat','moderation'],
 viewer: common,
};
const labels = {owner:'Owner',administrator:'Administrator',operator:'Operator',moderator:'Moderator',viewer:'Viewer'};
const delegatedRoles = ['administrator','operator','moderator','viewer'];
const accessByRole=Object.fromEntries(Object.entries(rolePages).map(([role,pages])=>[
 role,Object.freeze({role,label:labels[role],pages:Object.freeze(pages),power:['owner','administrator','operator'].includes(role)}),
]));

export function managerAccess(role) {
 return Object.hasOwn(accessByRole,role)?accessByRole[role]:null;
}

const read = {me:'overview',status:'overview',events:'overview',map:'map',settings:'settings',branding:'settings','branding/logo':'settings',guidance:'help',scripts:'scripts',addons:'addons',backups:'backups',automation:'automation',moderation:'moderation',audit:'audit',diagnostics:'performance',chat:'chat',logs:'logs',access:'access',instances:'instances'};
const write = {
  logout:'overview', access:'access', settings:'settings', console:'console', kick:'moderation', moderation:'moderation',
  'branding/logo':'settings','branding/remove':'settings',
  'scripts/toggle':'scripts', 'addons/upload':'addons', 'addons/order':'addons', 'addons/remove':'addons', 'addons/quarantine':'addons',
  'backups/create':'backups', 'backups/restore':'backups', 'backups/delete':'backups',
  'automation/create':'automation', 'automation/delete':'automation', 'automation/toggle':'automation',
  'instances/create':'instances', 'instances/import-pack':'instances', 'instances/power':'instances', 'instances/delete':'instances', 'instances/delete-all':'instances', 'instances/rename':'instances',
};
export function canUseManagerRoute(access, method, path) {
 if((method==='GET'&&path==='backups/download')||(method==='POST'&&path==='backups/import'))return access?.role==='owner'&&access.pages.includes('backups');
 if(['branding/dealer','branding/page'].includes(path)&&['GET','POST'].includes(method))return access?.role==='owner';
 if((method==='GET'&&['me','status','events'].includes(path))||(method==='POST'&&path==='logout'))return Boolean(access);
 if(method==='POST'&&path==='power')return access?.power===true;
 if(method==='POST'&&path.startsWith('guidance/'))return access?.pages.includes('help')===true;
 const table=method==='GET'?read:method==='POST'?write:null;
 if(!table||!Object.hasOwn(table,path))return null;
 return access?.pages.includes(table[path])===true;
}

export class ManagerMembers {
 constructor({directory,owners}) {
  this.file=join(directory,'manager-users.json');
  this.owners=owners;
  this.members=new Map();
  this.lock=new SerialStore();
 }
 async open() {
  const rows=await readDelegatedUsers(this.file);
  this.members=new Map(rows.filter(row=>!this.owners.has(row.steamId)).map(row=>[row.steamId,row.role]));
 }
 roleFor(steamId){return this.owners.has(steamId)?'owner':this.members.get(steamId)??null;}
 list(){
  return {users:[...this.owners].map(steamId=>({steamId,role:'owner'})).concat(this.rows(this.members)),roles:delegatedRoles.map(role=>managerAccess(role))};
 }
 rows(entries){return [...entries].sort(([a],[b])=>a.localeCompare(b)).map(([steamId,role])=>({steamId,role}));}
 change({action,steamId,role},actor,audit){
  if(this.roleFor(actor)!=='owner')throw Error('permission_denied');
  if(typeof steamId!=='string'||!STEAM_ID.test(steamId)||!['add','set','remove'].includes(action)||(action!=='remove'&&!delegatedRoles.includes(role)))throw Error('invalid_manager_user');
  if(this.owners.has(steamId))throw Error('manager_owner_protected');
  return this.lock.run(async()=>{
   if(action==='add'&&this.members.has(steamId))throw Error('manager_user_exists');
   if(action==='set'&&!this.members.has(steamId))throw Error('manager_user_missing');
   const next=new Map(this.members);
   if(action==='remove')next.delete(steamId);else next.set(steamId,role);
   if(next.size>100)throw Error('manager_users_limit');
   await audit?.();
   await atomicJson(this.file,{schema:1,users:this.rows(next)});
   this.members=next;
   return this.list();
  });
 }
}

export async function readDelegatedUsers(file){
 const value=await readJson(file,{schema:1,users:[]},32768);
 if(value?.schema!==1||!Array.isArray(value.users)||value.users.length>100)throw Error('invalid_manager_users');
 const seen=new Set();
 for(const row of value.users){
  if(typeof row?.steamId!=='string'||!STEAM_ID.test(row.steamId)||!delegatedRoles.includes(row.role)||seen.has(row.steamId))throw Error('invalid_manager_users');
  seen.add(row.steamId);
 }
 return value.users;
}
