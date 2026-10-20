import type { TestContext } from 'node:test';
import { createWorkflow, createRunnerEvent, appendEvent } from '../services/coordination/index.ts';
import { DurableExecutionCoordinator, createDurableCoordinationRunner } from '../services/coordination/durable/index.ts';
import type { SqliteCoordinationRunnerStore } from '../services/coordination/durable/index.ts';
import type { PreparedRunnerAction, RunnerPendingActionRecord, RunnerExecutionResult, RunnerActionExecutor, RunnerSupervisorProvider } from '../services/coordination/runner/types.ts';
import { runnerActionRef } from '../services/coordination/runner/policyGuard.ts';
import { fixture, fresh } from './durable-fixture.ts';

export const clock = { now: () => 10 };
export const prepared: PreparedRunnerAction = { actionId: 'action', executorId: 'test', operation: 'read', actionClass: 'read', fingerprint: 'fingerprint',
  retrySafety: 'safe', publicSummary: 'Public action', payload: { query: 'ordinary input' } };
export const record: RunnerPendingActionRecord = { workflowRunId: 'run', sessionId: 'session', taskId: 'task', action: prepared };
export function executionSeed(risk: 'ALLOW' | 'DENY' | 'NEEDS_USER' = 'ALLOW', runId = 'run') {
  const s = fresh(runId);
  return createWorkflow({ runId, roomId: 'room', goal: 'Goal', acceptanceCriteria: ['done'], supervisorAgentId: 'supervisor',
    participantAgentIds: ['supervisor'], executionMode: 'supervised_autonomous', now: 1,
    policy: { ...s.policy, riskRules: { read: risk } } });
}
export function registration(store: SqliteCoordinationRunnerStore, r = record, round = 'round') {
  const expected = store.getSnapshot(r.workflowRunId), ids = { nextId: (kind: string) => `${round}-${kind}-${r.action.actionId}` };
  const sessionEvent = createRunnerEvent(expected, 'SessionStarted', {
    sessionId: r.sessionId, workflowRunId: r.workflowRunId, mode: 'map.coord.task.v1', participants: ['supervisor'], initiator: 'supervisor',
    supervisor: 'supervisor', state: 'OPEN', policyId: expected.run.policyId, policyVersion: expected.run.policyVersion,
    goal: r.action.publicSummary, contextRef: `map.runner.v1:${round}`, createdAt: 10, updatedAt: 10,
  }, clock, ids, { sessionId: r.sessionId });
  const provisional = appendEvent(expected, sessionEvent);
  const taskEvent = createRunnerEvent(provisional, 'TaskAssigned', {
    taskId: r.taskId, workflowRunId: r.workflowRunId, sessionId: r.sessionId, title: r.action.publicSummary, goal: r.action.publicSummary,
    assigneeAgentId: 'supervisor', assignedByAgentId: 'supervisor', inputRefs: [runnerActionRef(r.action)], status: 'ASSIGNED', createdAt: 10, updatedAt: 10,
  }, clock, { nextId: () => `${round}-task-event-${r.action.actionId}` }, { sessionId: r.sessionId });
  return { expected, sessionEvent, taskEvent, record: r };
}
export const model = <T>(value: T) => ({ value, usage: { llmCalls: 1, inputTokens: 1, outputTokens: 1, estimatedCost: 0 }, provider: 'test', model: 'test', latencyMs: 0 });
export function executionFixture(t: TestContext, risk: 'ALLOW' | 'DENY' | 'NEEDS_USER' = 'ALLOW') {
  const f = fixture(t, executionSeed(risk)), calls = { execute: 0, plan: 0, verify: 0 };
  const executor: RunnerActionExecutor = { id: 'test', async prepare() { return structuredClone(prepared); }, async execute() { calls.execute++; return { status: 'succeeded', summary: 'raw private result' }; } };
  const registry = { get: (id: string) => id === 'test' ? executor : undefined };
  const provider: RunnerSupervisorProvider = {
    async plan() { calls.plan++; return model({ kind: 'execute', objective: 'Goal', action: { executorId: 'test', operation: 'read', arguments: {} } }); },
    async verify() { calls.verify++; return model({ taskOutcome: 'PASS', summary: 'Checked', criteria: [{ criterion: 'done', outcome: 'SATISFIED' }] }); },
  };
  const coordinator = new DurableExecutionCoordinator(f.store, registry, { clock });
  let serial = 0;
  const runner = createDurableCoordinationRunner({ coordinator, supervisorProvider: provider, clock, ids: { nextId: kind => `${kind}-${++serial}` } });
  const register = (r = record) => { const request = registration(f.store, r); coordinator.registerAction(r, request.expected, request.sessionEvent, request.taskEvent); return f.store.getSnapshot(r.workflowRunId).tasks[r.taskId]; };
  const snapshot = () => f.store.getSnapshot('run');
  const add = (type: Parameters<typeof createRunnerEvent>[1], payload: unknown) => f.store.append(createRunnerEvent(snapshot(), type, payload, clock, { nextId: () => `user-${++serial}` }));
  return { ...f, coordinator, registry, executor, provider, runner, calls, register, snapshot, add };
}
export const succeeded: RunnerExecutionResult = { status: 'succeeded', summary: 'Execution succeeded.' };
