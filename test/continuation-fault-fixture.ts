import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
export function fault(sqlMatch:string,when:'BEFORE'|'ACK',fn:()=>Promise<unknown>):Promise<unknown> {
 const prepare=DatabaseSync.prototype.prepare,exec=DatabaseSync.prototype.exec;let armed=false,fired=false;
 DatabaseSync.prototype.prepare=function(sql:string){const stmt=prepare.call(this,sql),run=stmt.run.bind(stmt);stmt.run=(...args:any[])=>{const result=run(...args);if(sql.includes(sqlMatch))armed=true;return result;};return stmt;};
 DatabaseSync.prototype.exec=function(sql:string){if(armed&&!fired&&sql==='COMMIT'&&when==='BEFORE'){fired=true;throw Error('injected');}const r=exec.call(this,sql);if(armed&&!fired&&sql==='COMMIT'&&when==='ACK'){fired=true;throw Error('ack lost');}return r;};
 return fn().finally(()=>{DatabaseSync.prototype.prepare=prepare;DatabaseSync.prototype.exec=exec;assert.equal(fired,true);});
}
