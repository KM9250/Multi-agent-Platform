import { DurableModelCallCoordinator } from './modelCallCoordinator';
import { createCoordinationRunner } from '../runner/runner';
import type { CoordinationRunnerDependencies } from '../runner/types';
import { DurableExecutionCoordinator } from './executionCoordinator';

type DurableRunnerDependencies = Omit<CoordinationRunnerDependencies, 'store' | 'pendingActions' | 'evidenceStore' | 'executors' | 'durableExecution' | 'durableModelCalls'> & {
  coordinator: DurableExecutionCoordinator;
  /** Trusted host invocation identity and model destination, separate from model text. */
  reconciliationContext?:{credential:unknown;destination:string};
};
/** Explicit trusted invocation only. Opening/restoring a database never calls this factory or starts work. */
export function createDurableCoordinationRunner({ coordinator, reconciliationContext, ...options }: DurableRunnerDependencies) {
  if (!(coordinator instanceof DurableExecutionCoordinator)) throw new Error('RUNNER_DURABLE_CONFIGURATION_REQUIRED');
  return createCoordinationRunner({ ...options, durableModelCalls: new DurableModelCallCoordinator(coordinator.store, options.supervisorProvider, options.clock,reconciliationContext), store: coordinator.store, pendingActions: coordinator.pendingActions,
    evidenceStore: coordinator.evidenceStore, executors: coordinator.executors, durableExecution: coordinator });
}
