import type { CoordinationSnapshot, WorkflowStatus } from './types';

const TERMINAL_WORKFLOW_STATUSES = new Set<WorkflowStatus>(['RESOLVED', 'CANCELLED', 'FAILED']);

/** Validates the durable cross-object invariants of a coordination projection. */
export const validateCoordinationSnapshot = (snapshot: CoordinationSnapshot): void => {
  const { run } = snapshot;
  if (snapshot.policy.policyId !== run.policyId || snapshot.policy.version !== run.policyVersion) {
    throw new Error('Snapshot policy identity must match the workflow policy.');
  }
  if (!run.participantAgentIds.includes(run.supervisorAgentId)) throw new Error('Supervisor must be a workflow participant.');
  if (run.satisfiedCriteria.some(criterion => !run.acceptanceCriteria.includes(criterion))) {
    throw new Error('Satisfied criteria must be acceptance criteria.');
  }
  for (const session of Object.values(snapshot.sessions)) {
    if (session.workflowRunId !== run.runId) throw new Error('Session belongs to another workflow.');
    if (session.policyId !== run.policyId || session.policyVersion !== run.policyVersion) throw new Error('Session policy must match the workflow policy.');
    if (session.supervisor !== run.supervisorAgentId) throw new Error('Session supervisor must match the workflow supervisor.');
    if (session.participants.some(id => !run.participantAgentIds.includes(id))) throw new Error('Only workflow Persona participants may join a session.');
    if (TERMINAL_WORKFLOW_STATUSES.has(run.status) && (session.state === 'OPEN' || session.state === 'SUSPENDED')) {
      throw new Error('Terminal workflow cannot contain an active session.');
    }
  }
  for (const task of Object.values(snapshot.tasks)) {
    if (task.workflowRunId !== run.runId) throw new Error('Task belongs to another workflow.');
    const session = snapshot.sessions[task.sessionId];
    if (!session) throw new Error('Task references a missing session.');
    if (session.mode !== 'map.coord.task.v1') throw new Error('Task session must use task mode.');
    if (!session.participants.includes(task.assigneeAgentId)) throw new Error('Task assignee must be a session participant.');
    if (!session.participants.includes(task.assignedByAgentId)) throw new Error('Task assigner must be a session participant.');
    if (TERMINAL_WORKFLOW_STATUSES.has(run.status) && task.status === 'ASSIGNED') {
      throw new Error('Terminal workflow cannot contain an active task.');
    }
  }
};
