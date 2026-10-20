import { createCoordinationRunner } from '../runner/runner';
import type { CoordinationRunnerDependencies } from '../runner/types';
import { DurableExecutionCoordinator } from './executionCoordinator';

type DurableRunnerDependencies = Omit<CoordinationRunnerDependencies, 'store' | 'pendingActions' | 'evidenceStore' | 'executors' | 'durableExecution'> & {
  coordinator: DurableExecutionCoordinator;
};
/** Explicit trusted invocation only. Opening/restoring a database never calls this factory or starts work. */
export function createDurableCoordinationRunner({ coordinator, ...options }: DurableRunnerDependencies) {
  if (!(coordinator instanceof DurableExecutionCoordinator)) throw new Error('RUNNER_DURABLE_CONFIGURATION_REQUIRED');
  return createCoordinationRunner({ ...options, store: coordinator.store, pendingActions: coordinator.pendingActions,
    evidenceStore: coordinator.evidenceStore, executors: coordinator.executors, durableExecution: coordinator });
}
