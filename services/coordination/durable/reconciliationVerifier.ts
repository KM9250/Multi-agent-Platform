import { types as utilTypes } from 'node:util';
import type { DurableTransaction } from './db';
import { canonicalJson, digest, DurableStoreError, requireIntegrity, parseJson } from './integrity';
import { validateRunnerUsage } from '../runner/model';
import { usageAmounts, safeAmount, costMicros } from './modelBudgetGuard';
import type { ReconciliationTarget, ReconciliationVerifierBinding, ReconciliationVerifierRegistry, ReconciliationVerifierResult, ReconciliationLimits } from './reconciliationTypes';

/** Preflight precedes any recursive copy. Descriptors and isProxy never invoke supplied accessors. */
export function reconciliationData<T>(value:T,maxBytes:number,maxDepth=32):T {
  const seen=new Set<object>(); let bytes=0, nodes=0;
  const stack:Array<{value:unknown;depth:number;exit?:boolean}>=[{value,depth:0}];
  while(stack.length) {
    const {value:v,depth,exit}=stack.pop()!;
    if(exit){seen.delete(v as object);continue;}
    if(depth>maxDepth||++nodes>maxBytes||bytes>maxBytes)throw new DurableStoreError('INVALID_JSON');
    if(v===null||typeof v==='boolean'){bytes+=5;continue;}
    if(typeof v==='string'){bytes+=Buffer.byteLength(v,'utf8')+2;continue;}
    if(typeof v==='number'){if(!Number.isFinite(v))throw new DurableStoreError('INVALID_JSON');bytes+=24;continue;}
    if(typeof v!=='object'||utilTypes.isProxy(v)||seen.has(v))throw new DurableStoreError('INVALID_JSON');
    seen.add(v);stack.push({value:v,depth,exit:true});
    const prototype=Object.getPrototypeOf(v);
    if(!Array.isArray(v)&&prototype!==Object.prototype&&prototype!==null)throw new DurableStoreError('INVALID_JSON');
    if(Object.getOwnPropertySymbols(v).length)throw new DurableStoreError('INVALID_JSON');
    const descriptors=Object.getOwnPropertyDescriptors(v);
    if(Object.values(descriptors).some(d=>!('value'in d)))throw new DurableStoreError('INVALID_JSON');
    const keys=Object.keys(descriptors);
    if(Array.isArray(v)) {
      if(keys.length!==v.length+1||keys.some(k=>k!=='length'&&!/^(0|[1-9][0-9]*)$/.test(k)))throw new DurableStoreError('INVALID_JSON');
      for(let i=0;i<v.length;i++){const d=descriptors[String(i)];if(!d)throw new DurableStoreError('INVALID_JSON');stack.push({value:d.value,depth:depth+1});}
    } else for(const key of keys) {
      if(['__proto__','prototype','constructor','then','toJSON'].includes(key))throw new DurableStoreError('INVALID_JSON');
      bytes+=Buffer.byteLength(key,'utf8')+4;stack.push({value:descriptors[key].value,depth:depth+1});
    }
    bytes+=2;
  }
  if(bytes>maxBytes)throw new DurableStoreError('INVALID_JSON');
  const text=canonicalJson(value);if(Buffer.byteLength(text)>maxBytes)throw new DurableStoreError('INVALID_JSON');
  return JSON.parse(text) as T;
}
const identifier=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9_.:@/-]{1,200}$/.test(x);
export function validateReconciliationTarget(input:ReconciliationTarget):ReconciliationTarget {
  const t=reconciliationData(input,2048);
  requireIntegrity(Object.keys(t).length===4&&['ACTION','MODEL'].includes(t.targetKind)&&[t.workflowRunId,t.targetId,t.attemptId].every(identifier));return t;
}
export function readReconciliationTarget(tx:DurableTransaction,input:ReconciliationTarget) {
  const target=validateReconciliationTarget(input);
  if(target.targetKind==='MODEL') {
    const ledger=tx.get('SELECT * FROM model_call_ledger WHERE workflow_run_id=? AND model_call_id=?',target.workflowRunId,target.targetId);
    const attempt=tx.get('SELECT * FROM model_call_attempts WHERE workflow_run_id=? AND model_call_id=? AND attempt_id=?',target.workflowRunId,target.targetId,target.attemptId);
    requireIntegrity(ledger&&attempt&&ledger.attempt_id===target.attemptId&&attempt.dispatch_intent_at!==null);
    const snapshot={target,ledger,attempt},quote=parseJson<{requestDigest:string;pricingId:string}>(ledger.quote_json);
    const targetSnapshot={target,providerId:ledger.provider_id,modelId:ledger.model_id,requestDigest:quote.requestDigest,pricingId:quote.pricingId,quoteDigest:digest(parseJson(ledger.quote_json)),originalRuntimeInstanceId:ledger.runtime_instance_id,originalGeneration:ledger.generation,dispatchIntentAt:attempt.dispatch_intent_at};
    return {target,targetDigest:digest(snapshot),targetSnapshot,ledger,attempt};
  }
  const ledger=tx.get('SELECT * FROM execution_ledger WHERE workflow_run_id=? AND action_id=?',target.workflowRunId,target.targetId);
  const registration=tx.get('SELECT * FROM pending_actions WHERE workflow_run_id=? AND action_id=?',target.workflowRunId,target.targetId);
  requireIntegrity(ledger&&registration&&ledger.attempt_id===target.attemptId&&ledger.reserved_at!==null&&ledger.state!=='PREPARED');
  const snapshot={target,ledger,registration},action=parseJson<{payload:unknown}>(registration.prepared_action_json);
  const targetSnapshot={target,executorId:ledger.executor_id,fingerprint:ledger.fingerprint,payloadDigest:digest(action.payload),actionDigest:registration.prepared_action_digest,registrationDigest:registration.registration_digest,sessionId:ledger.session_id,taskId:ledger.task_id,dispatchReservedAt:ledger.reserved_at};
  return {target,targetDigest:digest(snapshot),targetSnapshot,ledger,registration};
}
export function verifierBindingData(binding:ReconciliationVerifierBinding) {
  return {verifierId:binding.verifierId,contractVersion:binding.contractVersion,implementationDigest:binding.implementationDigest,
    authorityDomain:binding.authorityDomain,sourceSystem:binding.sourceSystem,account:binding.account,environment:binding.environment,
    claims:[...binding.claims],lookup:binding.lookup,usageDefinition:binding.usageDefinition,pricingIds:[...binding.pricingIds]};
}
export class ReconciliationVerifiers {
  readonly #get?:ReconciliationVerifierRegistry['get'];
  readonly #revoked?:ReconciliationVerifierRegistry['isRevoked'];
  readonly #observed=new Map<string,{binding:ReconciliationVerifierBinding;verify:ReconciliationVerifierBinding['verify'];digest:string}>();
  constructor(registry?:ReconciliationVerifierRegistry){this.#get=registry?.get.bind(registry);this.#revoked=registry?.isRevoked?.bind(registry);}
  isRevoked(id:string,bindingDigest:string):boolean {if(!this.#revoked)return false;try{const result=this.#revoked(id,bindingDigest);if(typeof result!=='boolean')throw new DurableStoreError('RECOVERY_UNAUTHORIZED');return result;}catch{throw new DurableStoreError('RECOVERY_UNAUTHORIZED');}}
  get(id:string):{binding:ReconciliationVerifierBinding;bindingDigest:string} {
    if(!identifier(id))throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
    let b:ReconciliationVerifierBinding|undefined;
    try{b=this.#get?.(id);}catch{throw new DurableStoreError('RECOVERY_UNAUTHORIZED');}
    if(!b||utilTypes.isProxy(b))throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
    const descriptors=Object.getOwnPropertyDescriptors(b);requireIntegrity(Object.values(descriptors).every(d=>'value'in d));
    requireIntegrity(b.verifierId===id&&typeof b.verify==='function'&&b.lookup==='NONE'&&/^[a-f0-9]{64}$/.test(b.implementationDigest));
    const data=reconciliationData(verifierBindingData(b),16384);
    requireIntegrity([data.verifierId,data.contractVersion,data.authorityDomain,data.sourceSystem,data.account,data.environment,data.usageDefinition].every(identifier)
      &&data.claims.length>0&&data.claims.every(k=>['ACTION_OUTCOME','MODEL_USAGE'].includes(k))&&data.pricingIds.every(identifier));
    const bindingDigest=digest(data),key=`${id}:${b.contractVersion}:${b.implementationDigest}`,old=this.#observed.get(key);
    if(old&&(old.binding!==b||old.verify!==b.verify||old.digest!==bindingDigest))throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
    this.#observed.set(key,{binding:b,verify:b.verify,digest:bindingDigest});return {binding:b,bindingDigest};
  }
}
export function validateVerifierResult(input:unknown,binding:ReconciliationVerifierBinding,target:ReconciliationTarget,targetDigest:string,now:number,limits:ReconciliationLimits):ReconciliationVerifierResult {
  const result=reconciliationData(input,limits.maxClaimBytes,limits.maxDepth) as ReconciliationVerifierResult;
  requireIntegrity(result&&Object.keys(result).every(k=>['target','targetDigest','source','claim','status','reasonCodes','expiresAt'].includes(k)));
  requireIntegrity(canonicalJson(validateReconciliationTarget(result.target))===canonicalJson(target)&&result.targetDigest===targetDigest);
  requireIntegrity(['VERIFIED','INCOMPLETE','REJECTED'].includes(result.status)&&Number.isSafeInteger(result.expiresAt)&&result.expiresAt>now&&result.expiresAt<=now+30*60*1000);
  requireIntegrity(Array.isArray(result.reasonCodes)&&result.reasonCodes.length<=32&&result.reasonCodes.every(x=>/^[A-Z][A-Z0-9_]{0,79}$/.test(x)));
  const s=result.source,c=result.claim;
  requireIntegrity(s&&Object.keys(s).length===6&&Object.values(s).every(identifier)&&s.authorityDomain===binding.authorityDomain&&s.sourceSystem===binding.sourceSystem&&s.account===binding.account&&s.environment===binding.environment);
  requireIntegrity(c&&Object.keys(c).every(k=>['kind','completeness','finality','outcome','usage','pricingId','currency','responseState','result','requestClosed','exhaustive','evidenceFields'].includes(k)));
  requireIntegrity(binding.claims.includes(c.kind)&&c.kind===(target.targetKind==='MODEL'?'MODEL_USAGE':'ACTION_OUTCOME')&&['COMPLETE','PARTIAL','UNKNOWN'].includes(c.completeness)&&['FINAL','PENDING','UNKNOWN'].includes(c.finality));
  requireIntegrity(Array.isArray(c.evidenceFields)&&c.evidenceFields.length<=64&&c.evidenceFields.every(x=>typeof x==='string'&&/^[A-Za-z0-9_.\[\]/-]{1,120}$/.test(x)));
  if(c.kind==='MODEL_USAGE') {
    requireIntegrity(c.outcome===undefined&&c.result===undefined);
    if(c.usage){
      requireIntegrity(Object.keys(c.usage).every(k=>['llmCalls','inputTokens','outputTokens','estimatedCost'].includes(k)));
      if(c.completeness==='COMPLETE'){validateRunnerUsage(c.usage);usageAmounts(validateRunnerUsage(c.usage));requireIntegrity(c.usage.llmCalls===1);}
      else for(const [key,value] of Object.entries(c.usage)){if(key==='estimatedCost')costMicros(value);else safeAmount(value);if(key==='llmCalls')requireIntegrity(value===1);}
    }
    if(c.completeness==='COMPLETE')requireIntegrity(c.usage&&c.currency==='USD'&&typeof c.pricingId==='string'&&binding.pricingIds.includes(c.pricingId));
    if(c.responseState!==undefined)requireIntegrity(['NOT_APPLICABLE_VERIFIED','UNAVAILABLE_REVIEW_REQUIRED'].includes(c.responseState));
    if(c.responseState==='NOT_APPLICABLE_VERIFIED')requireIntegrity(c.finality==='FINAL'&&c.requestClosed===true);
  } else {
    requireIntegrity(c.usage===undefined&&c.pricingId===undefined&&['EXECUTED_FINAL','NOT_EXECUTED_FINAL','PARTIAL_EFFECT','UNKNOWN'].includes(c.outcome??''));
    if(c.outcome==='EXECUTED_FINAL'||c.outcome==='NOT_EXECUTED_FINAL')requireIntegrity(c.completeness==='COMPLETE'&&c.finality==='FINAL');
    if(c.outcome==='NOT_EXECUTED_FINAL')requireIntegrity(c.requestClosed===true&&c.exhaustive===true);
    if(c.result) {
      requireIntegrity(Object.keys(c.result).every(k=>['status','summary','resultRef','evidenceRefs','errorCode','errorDetail'].includes(k))&&['succeeded','failed','uncertain'].includes(c.result.status)&&typeof c.result.summary==='string'&&c.result.summary.length<=4096);
      if(c.outcome==='EXECUTED_FINAL')requireIntegrity(c.result.status==='succeeded');
      if(c.outcome==='NOT_EXECUTED_FINAL')requireIntegrity(c.result.status==='failed');
    }
  }
  if(result.status==='VERIFIED')requireIntegrity(c.evidenceFields.length>0);
  return result;
}
/** Native promises only: never assimilate attacker-controlled thenables. */
export function nativeVerifierPromise<T>(value:T|Promise<T>):Promise<T> {
  if(utilTypes.isPromise(value))return new Promise((resolve,reject)=>Promise.prototype.then.call(value,resolve,reject));
  const safe=reconciliationData(value,64*1024);return Promise.resolve(safe);
}
