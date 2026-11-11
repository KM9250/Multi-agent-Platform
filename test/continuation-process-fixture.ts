import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const childFile=fileURLToPath(new URL('./continuation-crash-child.ts',import.meta.url));
export function child(args:string[]) {return fork(childFile,args,{execArgv:['--experimental-transform-types','--loader',fileURLToPath(new URL('./ts-loader.mjs',import.meta.url))],stdio:['ignore','ignore','pipe','ipc']});}
export async function exited(p:ReturnType<typeof child>){let stderr='';p.stderr!.on('data',c=>stderr+=c);const timer=setTimeout(()=>p.kill('SIGKILL'),15000);
 const result=await new Promise<{code:number|null;signal:string|null}>(resolve=>p.once('exit',(code,signal)=>resolve({code,signal})));clearTimeout(timer);return {...result,stderr};}
