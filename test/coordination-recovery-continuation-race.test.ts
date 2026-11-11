import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync,writeFileSync } from 'node:fs';
import { continuationFixture } from './continuation-fixture.ts';
import { child,exited } from './continuation-process-fixture.ts';
test('I01/I18: two real processes racing the same workflow produce at most one active Invocation and one model call',async t=>{
 const f=continuationFixture(t);f.manager.release(f.lease);const counter=join(f.dir,'external-count');writeFileSync(counter,'');
 const children=[child([f.path,'race','',counter]),child([f.path,'race','',counter])];
 const exits=children.map(p=>exited(p));
 await Promise.all(children.map(p=>new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('child readiness timeout')),10000);p.on('message',(m:{ready?:boolean})=>{if(m.ready){clearTimeout(timer);resolve();}});})));
 const samples:number[]=[];const timer=setInterval(()=>samples.push(Number(f.raw.prepare("SELECT count(*) n FROM recovery_invocations WHERE status IN ('ACTIVE','DRAINING')").get()!.n)),5);
 for(const p of children)p.send('go');const results=await Promise.all(exits);clearInterval(timer);for(const r of results)assert.equal(r.code,0,r.stderr);
 assert.equal(readFileSync(counter,'utf8'),'model\n');assert.ok(samples.every(n=>n<=1));
 assert.equal(f.raw.prepare('SELECT count(*) n FROM recovery_invocations').get()!.n,1);assert.equal(f.raw.prepare('SELECT count(*) n FROM planning_artifacts').get()!.n,1);
});
