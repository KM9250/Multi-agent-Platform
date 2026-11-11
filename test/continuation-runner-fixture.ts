import assert from 'node:assert/strict';
import { continuationFixture } from './continuation-fixture.ts';
import { createRunnerEvent } from '../services/coordination/runner/eventFactory.ts';
import { digest } from '../services/coordination/durable/integrity.ts';
import { prepared } from './durable-execution-fixture.ts';
import type { ContinuationPlanInput } from '../services/coordination/durable/continuationTypes.ts';
export function hold(f:ReturnType<typeof continuationFixture>) {
 f.store.append(createRunnerEvent(f.store.getSnapshot('run'),'WorkflowSuspended',{}, {now:Date.now},{nextId:()=> 'suspend'}));
 assert.throws(()=>f.store.assertRecoveryExecution('run'));
}
export function executeInput(f:ReturnType<typeof continuationFixture>):ContinuationPlanInput {
 return {operation:'BOUNDED_CONTINUATION',mode:'BOUNDED_EXECUTE',origin:'RECOVERY',workflowRunId:'run',requestId:'bounded-one',providerId:'synthetic',modelId:'test',start:'NEW_ROUND',actions:[{executorId:'test',operation:'read',actionClass:'read',payloadDigest:digest(prepared.payload)}],resume:{authorization:{type:'user'},reason:'Explicit bounded continuation'},
 limits:{maxRounds:1,maxModelCalls:2,maxActionDispatches:1,maxReadCalls:0,maxInputTokens:100,maxOutputTokens:100,maxCostMicros:1000000}};
}
