import type { CoordinationSnapshot, WorkflowStatus } from './types';
import { evaluateQuorumOutcome, requiredQuorumApprovals } from './quorum';

const TERMINAL_WORKFLOW_STATUSES = new Set<WorkflowStatus>(['RESOLVED', 'CANCELLED', 'FAILED']);
const TERMINAL_TASK_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
const TERMINAL_PRINCIPAL_STATUSES = new Set(['RESOLVED', 'CANCELLED']);

const validateResolvedSession = (snapshot: CoordinationSnapshot, sessionId: string): void => {
  const session = snapshot.sessions[sessionId];
  if (!session.resolution) throw new Error('Resolved session must include a resolution.');
  if (session.resolution.outcome !== 'SUCCEEDED' && session.resolution.outcome !== 'FAILED') {
    throw new Error('Session resolution outcome is invalid.');
  }
  if (session.mode === 'map.coord.task.v1') {
    const principals = Object.values(snapshot.tasks).filter(task => task.sessionId === sessionId);
    if (!principals.length) throw new Error('Resolved task session requires at least one task.');
    if (principals.some(task => !TERMINAL_TASK_STATUSES.has(task.status))) throw new Error('Resolved task session requires terminal tasks.');
    if (session.resolution.outcome === 'SUCCEEDED' && !principals.some(task => task.status === 'COMPLETED')) {
      throw new Error('Successful task session requires a completed task.');
    }
  } else if (session.mode === 'map.coord.decision.v1') {
    const principals = Object.values(snapshot.decisions).filter(decision => decision.sessionId === sessionId);
    if (!principals.length) throw new Error('Resolved decision session requires at least one decision.');
    if (principals.some(decision => !TERMINAL_PRINCIPAL_STATUSES.has(decision.status))) throw new Error('Resolved decision session requires terminal decisions.');
    if (session.resolution.outcome === 'SUCCEEDED' && !principals.some(decision => decision.status === 'RESOLVED')) {
      throw new Error('Successful decision session requires a resolved decision.');
    }
  } else {
    const principals = Object.values(snapshot.quorums).filter(quorum => quorum.sessionId === sessionId);
    if (!principals.length) throw new Error('Resolved quorum session requires at least one quorum.');
    if (principals.some(quorum => !TERMINAL_PRINCIPAL_STATUSES.has(quorum.status))) throw new Error('Resolved quorum session requires terminal quorums.');
    if (session.resolution.outcome === 'SUCCEEDED' && !principals.some(quorum => quorum.status === 'RESOLVED' && quorum.outcome === 'APPROVED')) {
      throw new Error('Successful quorum session requires an approved quorum.');
    }
  }
};

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
    if (!run.participantAgentIds.includes(session.initiator)) throw new Error('Session initiator must be a workflow participant.');
    if (!session.participants.includes(run.supervisorAgentId)) throw new Error('Session participants must include the supervisor.');
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
    if ((session.state === 'RESOLVED' || session.state === 'CANCELLED' || session.state === 'EXPIRED') && task.status === 'ASSIGNED') {
      throw new Error('Terminal session cannot contain an active task.');
    }
    if (TERMINAL_WORKFLOW_STATUSES.has(run.status) && task.status === 'ASSIGNED') {
      throw new Error('Terminal workflow cannot contain an active task.');
    }
  }
  for (const decision of Object.values(snapshot.decisions)) {
    if (decision.workflowRunId !== run.runId) throw new Error('Decision belongs to another workflow.');
    const session = snapshot.sessions[decision.sessionId];
    if (!session) throw new Error('Decision references a missing session.');
    if (session.mode !== 'map.coord.decision.v1') throw new Error('Decision session must use decision mode.');
    if (!session.participants.includes(decision.authorityAgentId) || !run.participantAgentIds.includes(decision.authorityAgentId)) throw new Error('Decision authority must be a workflow and session participant.');
    if (!decision.question?.trim()) throw new Error('Decision question is required.');
    if (!['OPEN', 'RESOLVED', 'CANCELLED'].includes(decision.status)) throw new Error('Decision status is invalid.');
    const options = decision.options?.map(value => value.trim());
    if (options && (!options.length || options.some(value => !value) || new Set(options).size !== options.length)) throw new Error('Decision options must be non-empty and unique.');
    const hasResultFields = decision.value !== undefined || decision.rationaleRef !== undefined || decision.evidenceRefs !== undefined;
    if (decision.status === 'OPEN' && hasResultFields) throw new Error('Open decision cannot contain terminal result fields.');
    if (decision.status === 'CANCELLED' && hasResultFields) throw new Error('Cancelled decision cannot contain terminal result fields.');
    if (decision.status === 'RESOLVED' && (!decision.value?.trim() || (options && !options.includes(decision.value)))) throw new Error('Resolved decision must contain a valid value.');
    if (decision.status === 'RESOLVED' && decision.rationaleRef !== undefined && !decision.rationaleRef.trim()) throw new Error('Decision rationale reference cannot be empty.');
    if (decision.status === 'RESOLVED' && decision.evidenceRefs) {
      const refs = decision.evidenceRefs.map(ref => ref.trim());
      if (refs.some(ref => !ref)) throw new Error('Decision evidence references cannot be empty.');
      if (new Set(refs).size !== refs.length) throw new Error('Decision evidence references cannot contain duplicates.');
    }
    if ((session.state === 'RESOLVED' || session.state === 'CANCELLED' || session.state === 'EXPIRED') && decision.status === 'OPEN') throw new Error('Terminal session cannot contain an open decision.');
  }
  for (const quorum of Object.values(snapshot.quorums)) {
    if (quorum.workflowRunId !== run.runId) throw new Error('Quorum belongs to another workflow.');
    const session = snapshot.sessions[quorum.sessionId];
    if (!session) throw new Error('Quorum references a missing session.');
    if (session.mode !== 'map.coord.quorum.v1') throw new Error('Quorum session must use quorum mode.');
    if (!quorum.question?.trim()) throw new Error('Quorum question is required.');
    if (!['OPEN', 'RESOLVED', 'CANCELLED'].includes(quorum.status)) throw new Error('Quorum status is invalid.');
    if (!quorum.eligibleAgentIds.length || new Set(quorum.eligibleAgentIds).size !== quorum.eligibleAgentIds.length) throw new Error('Eligible agents must be non-empty and unique.');
    if (quorum.eligibleAgentIds.some(id => !session.participants.includes(id) || !run.participantAgentIds.includes(id))) throw new Error('Eligible agent must be a workflow and session participant.');
    requiredQuorumApprovals(quorum.threshold, quorum.eligibleAgentIds.length);
    for (const [agentId, vote] of Object.entries(quorum.votes)) if (!quorum.eligibleAgentIds.includes(agentId) || !['APPROVE', 'REJECT', 'ABSTAIN'].includes(vote)) throw new Error('Quorum contains an invalid vote.');
    if (quorum.status === 'OPEN' && quorum.outcome !== undefined) throw new Error('Open quorum cannot contain an outcome.');
    if (quorum.status === 'CANCELLED' && quorum.outcome !== undefined) throw new Error('Cancelled quorum cannot contain an outcome.');
    if (quorum.status === 'RESOLVED') { const result = evaluateQuorumOutcome(quorum); if (!quorum.outcome) throw new Error('Resolved quorum must contain an outcome.'); if (result.state === 'PENDING' || result.state !== quorum.outcome) throw new Error('Resolved quorum outcome is inconsistent with votes.'); }
    if ((session.state === 'RESOLVED' || session.state === 'CANCELLED' || session.state === 'EXPIRED') && quorum.status === 'OPEN') throw new Error('Terminal session cannot contain an open quorum.');
  }
  for (const evaluation of Object.values(snapshot.evaluations)) {
    if (evaluation.workflowRunId !== run.runId) throw new Error('Evaluation belongs to another workflow.');
    const session = snapshot.sessions[evaluation.sessionId];
    if (!session) throw new Error('Evaluation references a missing session.');
    if (!session.participants.includes(evaluation.evaluatorAgentId)) throw new Error('Evaluator must be a session participant.');
    if (!['PASS', 'FAIL', 'INCONCLUSIVE'].includes(evaluation.outcome)) throw new Error('Evaluation outcome is invalid.');
    const target = evaluation.target;
    if (target.type === 'artifact') { if (!target.ref?.trim()) throw new Error('Evaluation artifact reference is required.'); }
    else {
      let entity;
      if (target.type === 'task') entity = snapshot.tasks[target.id];
      else if (target.type === 'decision') entity = snapshot.decisions[target.id];
      else if (target.type === 'quorum') entity = snapshot.quorums[target.id];
      else throw new Error('Evaluation target type is invalid.');
      if (!entity) throw new Error('Evaluation target does not exist.');
      if (entity.sessionId !== evaluation.sessionId) throw new Error('Evaluation target belongs to another session.');
    }
  }
  for (const session of Object.values(snapshot.sessions)) {
    if (session.state === 'RESOLVED') validateResolvedSession(snapshot, session.sessionId);
  }
};
