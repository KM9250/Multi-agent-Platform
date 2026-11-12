import type { DurableDatabase } from './db';
import type { WorkflowLease } from './runtimeLease';
import type { ContinuationPlan, BoundedProvider } from './continuationTypes';
import { SqliteCoordinationRunnerStore } from './durableCoordinationStore';
import { DurableExecutionCoordinator } from './executionCoordinator';
import { createDurableCoordinationRunner } from './durableRunner';
import { requireIntegrity, DurableStoreError } from './integrity';

/** Reuses the existing Runner, registration, policy, result and VERIFY implementation.
 * Only a private Invocation context can pass its DB gates. */
export async function runBoundedRunner(db:DurableDatabase,lease:WorkflowLease,p:ContinuationPlan,provider:BoundedProvider,signal:AbortSignal,admitRound:()=>void,reconciliationContext?:{credential:unknown;destination:string}):Promise<void> {
  requireIntegrity(provider.runner);
  const coordinator=new DurableExecutionCoordinator(new SqliteCoordinationRunnerStore(db,lease),db.boundedExecutorRegistry(p));
  const runner=createDurableCoordinationRunner({coordinator,supervisorProvider:provider.runner,reconciliationContext});
  for(let n=0;n<p.limits.maxRounds;n++) {
    admitRound();const result=await runner.runOneRound(p.workflowRunId,{signal});
    if(result.reason==='needs_user')throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
    if(!['round_completed','completed','terminal'].includes(result.reason))throw new DurableStoreError('CONTINUATION_STATE_CHANGED');
    if(result.reason!=='round_completed')return;
  }
}
