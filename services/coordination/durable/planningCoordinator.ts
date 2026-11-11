/** Fixed bounded collection. Timers are a wakeup only: synchronous event-loop stalls
 * are checked with a monotonic deadline before a response is accepted. */
export async function collectBoundedResponse<T>(invoke:(signal:AbortSignal)=>Promise<T>,timeoutMs:number,graceMs:number,signal?:AbortSignal):Promise<{value?:T;error?:unknown;timedOut:boolean;aborted:boolean}> {
  const deadline=performance.now()+timeoutMs,controller=new AbortController();
  let timer:ReturnType<typeof setTimeout>|undefined,graceTimer:ReturnType<typeof setTimeout>|undefined;
  let abort:()=>void=()=>{},timerFired=false;
  const interruption=new Promise<'INTERRUPTED'>(resolve=>{abort=()=>{controller.abort();resolve('INTERRUPTED');};signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>{timerFired=true;abort();},timeoutMs);});
  if(signal?.aborted)abort();
  const work=Promise.resolve().then(()=>signal?.aborted?undefined:invoke(controller.signal)).then(value=>({value}),(error:unknown)=>({value:undefined,error}));
  try {
    let result=await Promise.race([work,interruption]);
    const timedOut=performance.now()>=deadline,aborted=!!signal?.aborted;
    if(result==='INTERRUPTED') result=await Promise.race([work,new Promise<{value:undefined}>(resolve=>{graceTimer=setTimeout(()=>resolve({value:undefined}),graceMs);})]);
    return {value:performance.now()<deadline+graceMs?result.value:undefined,error:'error' in result?result.error:undefined,timedOut:timerFired||timedOut||performance.now()>=deadline,aborted:aborted||!!signal?.aborted};
  }finally{clearTimeout(timer);clearTimeout(graceTimer);signal?.removeEventListener('abort',abort);controller.abort();}
}
export { RecoveryContinuationCoordinator as PlanningCoordinator } from './recoveryContinuationCoordinator';
