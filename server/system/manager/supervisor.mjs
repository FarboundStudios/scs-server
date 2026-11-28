import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {StringDecoder} from 'node:string_decoder';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
const wait=ms=>new Promise(r=>{const t=setTimeout(r,ms);t.unref?.();});
export class GameSupervisor extends EventEmitter {
 constructor({env,logs,stopTimeoutMs=10000,worker=fileURLToPath(new URL('../game-main.mjs',import.meta.url)),forkImpl=fork,execArgv}={}){super();Object.assign(this,{env,logs,stopTimeoutMs,worker,forkImpl,execArgv});this.state='stopped';this.child=null;this.meta=null;this.snapshot=null;this.pending=new Map();this.restarts=[];this.shuttingDown=false;this.history=[];this.startedAt=null;this.revision=0;}
 touch(){this.revision++;this.emit('change');}
 start(){if(this.shuttingDown)throw Error('game_unavailable');if(this.child||['starting','stopping'].includes(this.state))throw Error('game_busy');clearTimeout(this.retry);this.intent='running';this.state='starting';this.snapshot=null;this.touch();
  let child;try{child=this.child=this.forkImpl(this.worker,[],{env:{...this.env,HOST:'127.0.0.1',HEAVYMP_MANAGER_WORKER:'1'},execArgv:this.execArgv,stdio:['pipe','pipe','pipe','ipc'],windowsHide:true});}catch(e){this.child=null;this.state='crashed';this.touch();this.logs.record('Game process could not start: '+e.message,'error','manager');throw e;}this.startedAt=Date.now();this.logs.record('Starting game process…','info','manager');
  for(const [stream,level]of [[child.stdout,'info'],[child.stderr,'error']]){let buffer='',decoder=new StringDecoder('utf8');stream.on('data',chunk=>{buffer+=decoder.write(chunk);let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);this.logs.record(line,level);(level==='error'?process.stderr:process.stdout).write(line+'\n');}if(buffer.length>8192){this.logs.record(buffer,level);buffer='';}});stream.on('end',()=>{if(buffer)this.logs.record(buffer,level);});}
  child.on('message',m=>{if(this.child!==child)return;if(m?.type==='manager-ready'&&Number.isInteger(m.port)&&m.port>0&&m.port<65536){this.meta=m.meta;this.port=m.port;this.state='running';this.touch();this.emit('ready',m.meta);}
   if(m?.type==='manager-chat')this.logs.chat(m.message);
   if(m?.type==='manager-snapshot'){this.snapshot=m.data;this.sampledAt=Date.now();this.history.push({at:Date.now(),players:m.data.health.players,cpu:m.data.process.cpuPercent,rss:m.data.process.rssMb,tick:m.data.health.metrics.lastTickMs,heap:m.data.process.heapMb,loop:m.data.health.metrics.eventLoopP95Ms});if(this.history.length>300)this.history.shift();this.touch();}
   if(m?.type==='manager-reply'){const p=this.pending.get(m.id);if(p){clearTimeout(p.timer);this.pending.delete(m.id);m.error?p.reject(Error(m.error)):p.resolve(m.result);}}
  });
  const finished=(code,signal)=>{if(this.child!==child)return;this.child=null;this.port=null;this.snapshot=null;this.state=code===0||this.intent==='stopped'?'stopped':'crashed';for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('game_unavailable'));}this.pending.clear();this.logs.record(`Game process ${this.state} (${signal??code??'unknown'}).`,this.state==='crashed'?'error':'info','manager');this.emit('exit');this.touch();
   if(this.intent==='running'&&!this.shuttingDown){const t=Date.now();this.restarts=this.restarts.filter(v=>t-v<60000);if(this.restarts.length<5){this.restarts.push(t);this.retry=setTimeout(()=>{try{this.start();}catch{}},Math.min(30000,1000*2**(this.restarts.length-1)));this.retry.unref?.();}else this.logs.record('Automatic restart paused after repeated failures. Use Start after correcting the error.','error','manager');}
  };child.on('error',e=>{this.logs.record('Game process error: '+e.message,'error','manager');if(!child.pid)finished(null,'spawn-error');});child.once('exit',finished);return {ok:true,state:this.state};
 }
 async stop(force=false){clearTimeout(this.retry);this.intent='stopped';const child=this.child;if(!child){this.state='stopped';return {ok:true,state:this.state};}this.state='stopping';this.touch();const ended=new Promise(r=>child.once('exit',r));
  if(force)child.kill('SIGKILL');else{if(child.connected)child.send({type:'manager-stop'});else child.kill();}
  const exited=await Promise.race([ended.then(()=>true),wait(this.stopTimeoutMs).then(()=>false)]);if(!exited){this.logs.record('Graceful stop timed out; terminating owned game process.','warn','manager');child.kill('SIGKILL');await Promise.race([ended,wait(2000)]);}
  if(this.child===child)throw Error('game_stop_failed');return {ok:true,state:this.state};
 }
 async power(action){if(this.busy)throw Error('game_busy');this.busy=true;try{if(action==='start')return this.start();if(action==='stop')return await this.stop();if(action==='kill')return await this.stop(true);if(action==='restart'){await this.stop();return this.start();}throw Error('unknown_action');}finally{this.busy=false;}}
 command(command,args={}){if(this.state!=='running'||!this.child?.connected)return Promise.reject(Error('game_unavailable'));if(this.pending.size>=32)return Promise.reject(Error('console_busy'));const id=randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('command_timeout'));},8000);this.pending.set(id,{resolve,reject,timer});this.child.send({type:'manager-command',id,command,args});});}
 status(){return {revision:this.revision,state:this.state,busy:!!this.busy,pid:this.child?.pid??null,startedAt:this.startedAt,sampledAt:this.sampledAt??null,meta:this.meta,snapshot:this.snapshot,history:this.history,managerMemoryMb:Math.round(process.memoryUsage().rss/1048576),droppedLogs:this.logs.dropped};}
 async close(){this.shuttingDown=true;await this.stop();}
}
