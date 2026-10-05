import type { AcceptanceCriterionEvaluatedPayload, CommitmentAcceptedPayload, CommitmentGateResult, CommitmentPolicyEvaluationPayload, CommitmentRejectedPayload, CommitmentRequestedPayload, CoordinationSnapshot, ProgressRecordedPayload, UsageRecordedPayload, WorkflowBlockedPayload, WorkflowCommitmentState, WorkflowResumePayload, WorkflowStatus } from './types';
import { ALLOWED_WHILE_STOPPED, COORDINATION_EVENT_TYPES, STOPPED_WORKFLOW_STATUSES, TERMINAL_WORKFLOW_STATUSES } from './types';
import { evaluateQuorumOutcome, requiredQuorumApprovals } from './quorum';
import { validatePolicy } from './policy';
import { applyProgress, applyUsageDelta, emptyWorkflowUsage, validateProgressPayload, validateUsagePayload } from './usage';

const TERMINAL_TASK_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
const TERMINAL_PRINCIPAL_STATUSES = new Set(['RESOLVED', 'CANCELLED']);
const ACCEPTANCE_EVIDENCE_TYPES = new Set(['TaskCompleted', 'TaskFailed', 'DecisionResolved', 'QuorumResolved', 'EvaluationAdded', 'SessionResolved']);
const BUDGET_FIELDS = ['maxWallTimeMs', 'maxRounds', 'maxLlmCalls', 'maxInputTokens', 'maxOutputTokens', 'maxEstimatedCost', 'maxConsecutiveErrors', 'maxNoProgressCycles'] as const;
const INTEGER_USAGE_FIELDS = ['rounds', 'llmCalls', 'inputTokens', 'outputTokens', 'consecutiveErrors', 'noProgressCycles'] as const;

const validateStringArray = (values: unknown, name: string): string[] => {
  if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !value.trim())) throw new Error(`${name} must contain non-empty strings.`);
  const normalized = values.map(value => value.trim());
  if (new Set(normalized).size !== normalized.length) throw new Error(`${name} cannot contain duplicates.`);
  return normalized;
};

const validateGateResult = (result: CommitmentGateResult): void => {
  if (!result || typeof result.allowed !== 'boolean') throw new Error('Policy evaluation result is invalid.');
  validateStringArray(result.activeSessionIds, 'activeSessionIds');
  validateStringArray(result.missingCriteria, 'missingCriteria');
  validateStringArray(result.reasons, 'reasons');
  if (result.exhaustedBudget !== undefined && !['maxWallTimeMs', 'maxRounds', 'maxLlmCalls', 'maxInputTokens', 'maxOutputTokens', 'maxEstimatedCost', 'maxConsecutiveErrors', 'maxNoProgressCycles'].includes(result.exhaustedBudget)) throw new Error('Policy exhausted budget is invalid.');
};

const arraysEqual = (left: readonly string[] | undefined, right: readonly string[] | undefined): boolean =>
  left === undefined ? right === undefined : right !== undefined && left.length === right.length && left.every((value, index) => value === right[index]);

const commitmentsEqual = (left: WorkflowCommitmentState | undefined, right: WorkflowCommitmentState | undefined): boolean =>
  left === undefined ? right === undefined : right !== undefined
    && left.commitmentId === right.commitmentId && left.status === right.status
    && left.requestedByAgentId === right.requestedByAgentId && left.requestedAt === right.requestedAt
    && left.summary === right.summary && arraysEqual(left.evidenceRefs, right.evidenceRefs)
    && left.decidedByAgentId === right.decidedByAgentId && left.decidedAt === right.decidedAt
    && left.rejectionReason === right.rejectionReason;

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
  validatePolicy(snapshot.policy);
  if (snapshot.policy.policyId !== run.policyId || snapshot.policy.version !== run.policyVersion) {
    throw new Error('Snapshot policy identity must match the workflow policy.');
  }
  if (!run.budget || BUDGET_FIELDS.some(field => run.budget[field] !== snapshot.policy.budgets[field])) throw new Error('Workflow budget must match the policy budget.');
  if (!['RUNNING', 'SUSPENDED', 'RESOLVED', 'CANCELLED', 'FAILED', 'BLOCKED'].includes(run.status)) throw new Error('Workflow status is invalid.');
  if (!['interactive', 'supervised_autonomous'].includes(run.executionMode)) throw new Error('Execution mode is invalid.');
  const participants = validateStringArray(run.participantAgentIds, 'participantAgentIds');
  if (!participants.length) throw new Error('Workflow requires participants.');
  validateStringArray(run.acceptanceCriteria, 'acceptanceCriteria');
  validateStringArray(run.satisfiedCriteria, 'satisfiedCriteria');
  if (run.satisfiedCriteria.some(value => !run.acceptanceCriteria.includes(value))) throw new Error('Satisfied criteria must belong to acceptance criteria.');
  if (!run.usage || INTEGER_USAGE_FIELDS.some(field => !Number.isSafeInteger(run.usage[field]) || run.usage[field] < 0)
    || !Number.isFinite(run.usage.estimatedCost) || run.usage.estimatedCost < 0) throw new Error('Workflow usage must be finite and non-negative.');
  if (!run.participantAgentIds.includes(run.supervisorAgentId)) throw new Error('Supervisor must be a workflow participant.');
  if (!Array.isArray(snapshot.events) || snapshot.events.length === 0 || snapshot.events[0].type !== 'WorkflowRunCreated') throw new Error('Journal must begin with WorkflowRunCreated.');
  if (run.currentSessionId !== undefined && !snapshot.sessions[run.currentSessionId]) throw new Error('currentSessionId must reference an existing session.');
  if (snapshot.events.filter(event => event.type === 'WorkflowRunCreated').length !== 1) throw new Error('Journal must contain exactly one WorkflowRunCreated event.');
  const creation = snapshot.events[0];
  const creationPayload = creation.payload as Partial<Pick<typeof run, 'roomId' | 'goal' | 'acceptanceCriteria' | 'supervisorAgentId' | 'participantAgentIds' | 'executionMode' | 'policyId' | 'policyVersion'>> | null;
  if (!creationPayload || typeof creationPayload !== 'object' || creation.actorAgentId !== run.supervisorAgentId || creation.timestamp !== run.createdAt
    || creationPayload.roomId !== run.roomId || creationPayload.goal !== run.goal
    || !arraysEqual(creationPayload.acceptanceCriteria, run.acceptanceCriteria)
    || creationPayload.supervisorAgentId !== run.supervisorAgentId
    || !arraysEqual(creationPayload.participantAgentIds, run.participantAgentIds)
    || creationPayload.executionMode !== run.executionMode || creationPayload.policyId !== run.policyId
    || creationPayload.policyVersion !== run.policyVersion) throw new Error('WorkflowRunCreated must anchor immutable workflow metadata.');

  const eventIds = new Set<string>(); const idempotencyKeys = new Set<string>(); const satisfied = new Set<string>();
  const usedCommitmentIds = new Set<string>(); let replayedCommitment: WorkflowCommitmentState | undefined;
  let replayedUsage = emptyWorkflowUsage(); let previousTimestamp = -1;
  let replayedWorkflowStatus: WorkflowStatus = 'RUNNING';
  snapshot.events.forEach((event, index) => {
    if (!COORDINATION_EVENT_TYPES.has(event.type)) throw new Error('Coordination event type is invalid.');
    if (index > 0 && TERMINAL_WORKFLOW_STATUSES.has(replayedWorkflowStatus)) throw new Error('Terminal workflow cannot contain later events.');
    if (index > 0 && STOPPED_WORKFLOW_STATUSES.has(replayedWorkflowStatus) && !ALLOWED_WHILE_STOPPED.has(event.type)) {
      throw new Error('Stopped workflow contains an invalid event.');
    }
    if (event.sequence !== index + 1) throw new Error('Journal event sequences must be contiguous.');
    if (event.workflowRunId !== run.runId) throw new Error('Journal event belongs to another workflow.');
    if (!event.eventId?.trim() || eventIds.has(event.eventId)) throw new Error('Journal event IDs must be non-empty and unique.');
    if (!Number.isFinite(event.timestamp) || event.timestamp < 0 || event.timestamp < previousTimestamp) throw new Error('Journal event timestamps must be finite, non-negative, and monotonic.');
    previousTimestamp = event.timestamp;
    eventIds.add(event.eventId);
    if (event.idempotencyKey) { if (!event.idempotencyKey.trim() || idempotencyKeys.has(event.idempotencyKey)) throw new Error('Journal idempotency keys must be unique.'); idempotencyKeys.add(event.idempotencyKey); }
    if (event.type === 'AcceptanceCriterionEvaluated') {
      if (event.sessionId !== undefined || event.actorAgentId !== run.supervisorAgentId) throw new Error('Acceptance evaluation must be workflow-scoped and supervisor-owned.');
      const payload = event.payload as AcceptanceCriterionEvaluatedPayload; const criterion = payload?.criterion?.trim();
      if (!criterion || !run.acceptanceCriteria.includes(criterion)) throw new Error('Acceptance criterion is unknown.');
      if (payload.outcome !== 'SATISFIED' && payload.outcome !== 'UNSATISFIED') throw new Error('Acceptance outcome is invalid.');
      const evidenceIds = validateStringArray(payload.evidenceEventIds, 'evidenceEventIds');
      if (payload.note !== undefined && !payload.note.trim()) throw new Error('Acceptance note cannot be empty.');
      if (payload.outcome === 'SATISFIED' && !evidenceIds.length) throw new Error('Satisfied criterion requires evidence.');
      for (const id of evidenceIds) { const evidenceIndex = snapshot.events.findIndex(candidate => candidate.eventId === id); if (evidenceIndex < 0 || evidenceIndex >= index) throw new Error('Acceptance evidence must reference a prior event.'); if (!ACCEPTANCE_EVIDENCE_TYPES.has(snapshot.events[evidenceIndex].type)) throw new Error('Acceptance evidence type is not allowed.'); }
      if (payload.outcome === 'SATISFIED') satisfied.add(criterion); else satisfied.delete(criterion);
    }
    if (event.type === 'UsageRecorded') {
      if (TERMINAL_WORKFLOW_STATUSES.has(replayedWorkflowStatus)) throw new Error('Usage cannot be recorded after workflow termination.');
      if (event.sessionId !== undefined || event.actorAgentId !== run.supervisorAgentId) throw new Error('Usage must be workflow-scoped and supervisor-owned.');
      const payload = validateUsagePayload(event.payload as UsageRecordedPayload);
      replayedUsage = applyUsageDelta(replayedUsage, payload);
    }
    if (event.type === 'ProgressRecorded') {
      if (replayedWorkflowStatus !== 'RUNNING') throw new Error('Progress can only be recorded while workflow is running.');
      if (event.sessionId !== undefined || event.actorAgentId !== run.supervisorAgentId) throw new Error('Progress must be workflow-scoped and supervisor-owned.');
      const payload = validateProgressPayload(event.payload as ProgressRecordedPayload);
      for (const id of payload.evidenceEventIds ?? []) { const evidenceIndex = snapshot.events.findIndex(candidate => candidate.eventId === id); if (evidenceIndex < 0 || evidenceIndex >= index) throw new Error('Progress evidence must reference a prior event.'); }
      replayedUsage = applyProgress(replayedUsage, payload);
    }
    if (event.type === 'PolicyEvaluated') {
      if (event.sessionId !== undefined || event.actorAgentId !== run.supervisorAgentId) throw new Error('Policy evaluation must be workflow-scoped and supervisor-owned.');
      const payload = event.payload as CommitmentPolicyEvaluationPayload; if (payload?.scope !== 'commitment') throw new Error('Policy evaluation scope is invalid.'); validateGateResult(payload.result);
    }
    if (['CommitmentRequested', 'CommitmentAccepted', 'CommitmentRejected'].includes(event.type) && event.sessionId !== undefined) throw new Error('Commitment events must be workflow-scoped.');
    if (event.type === 'CommitmentRequested') {
      const payload = event.payload as CommitmentRequestedPayload; const commitmentId = payload?.commitmentId?.trim();
      if (!event.actorAgentId || !run.participantAgentIds.includes(event.actorAgentId)) throw new Error('Commitment requester must be a workflow participant.');
      if (!commitmentId) throw new Error('Commitment ID is required.');
      if (usedCommitmentIds.has(commitmentId)) throw new Error('Commitment ID has already been used.');
      if (replayedCommitment?.status === 'REQUESTED') throw new Error('A commitment request is already pending.');
      const previous = snapshot.events[index - 1]; const previousPayload = previous?.payload as CommitmentPolicyEvaluationPayload | undefined;
      if (previous?.type !== 'PolicyEvaluated' || previousPayload?.scope !== 'commitment' || previousPayload.result?.allowed !== true) throw new Error('Commitment request requires an immediately preceding allowed policy evaluation.');
      const summary = payload.summary?.trim(); if (payload.summary !== undefined && !summary) throw new Error('Commitment summary cannot be empty.');
      const evidenceRefs = payload.evidenceRefs === undefined ? undefined : validateStringArray(payload.evidenceRefs, 'commitment evidenceRefs');
      usedCommitmentIds.add(commitmentId);
      replayedCommitment = { commitmentId, status: 'REQUESTED', requestedByAgentId: event.actorAgentId, requestedAt: event.timestamp, ...(summary ? { summary } : {}), ...(evidenceRefs !== undefined ? { evidenceRefs } : {}) };
    } else if (event.type === 'CommitmentRejected' || event.type === 'CommitmentAccepted') {
      if (event.actorAgentId !== run.supervisorAgentId) throw new Error('Only the configured supervisor may decide a commitment.');
      if (!replayedCommitment || replayedCommitment.status !== 'REQUESTED') throw new Error('No commitment request is pending.');
      const commitmentId = (event.payload as CommitmentAcceptedPayload)?.commitmentId?.trim();
      if (!commitmentId || commitmentId !== replayedCommitment.commitmentId) throw new Error('Commitment ID does not match the pending request.');
      if (event.type === 'CommitmentAccepted') {
        replayedCommitment = { ...replayedCommitment, status: 'ACCEPTED', decidedByAgentId: event.actorAgentId, decidedAt: event.timestamp };
        replayedWorkflowStatus = 'RESOLVED';
      }
      else {
        const reason = (event.payload as CommitmentRejectedPayload)?.reason?.trim(); if (!reason) throw new Error('Commitment rejection reason is required.');
        replayedCommitment = { ...replayedCommitment, status: 'REJECTED', decidedByAgentId: event.actorAgentId, decidedAt: event.timestamp, rejectionReason: reason };
      }
    } else if (event.type === 'WorkflowCancelled') {
      if (replayedCommitment?.status === 'REQUESTED') replayedCommitment = { ...replayedCommitment, status: 'CANCELLED', decidedAt: event.timestamp };
      replayedWorkflowStatus = 'CANCELLED';
    }
    if (event.type === 'WorkflowSuspended' || event.type === 'WorkflowBlocked') {
      if (replayedWorkflowStatus !== 'RUNNING') throw new Error('Workflow can only be stopped while running.');
      if (event.actorAgentId !== run.supervisorAgentId) throw new Error('Only the configured supervisor may stop the workflow.');
      if (event.type === 'WorkflowBlocked' && !(event.payload as WorkflowBlockedPayload | undefined)?.reason?.trim()) throw new Error('Workflow block reason is required.');
      replayedWorkflowStatus = event.type === 'WorkflowSuspended' ? 'SUSPENDED' : 'BLOCKED';
    } else if (event.type === 'WorkflowResumed') {
      if (replayedWorkflowStatus !== 'SUSPENDED' && replayedWorkflowStatus !== 'BLOCKED') throw new Error('Workflow can only resume from a stopped state.');
      if (event.actorAgentId !== run.supervisorAgentId) throw new Error('Only the configured supervisor may resume the workflow.');
      if ((event.payload as WorkflowResumePayload | undefined)?.authorization?.type !== 'user') throw new Error('User authorization is required to resume workflow.');
      replayedWorkflowStatus = 'RUNNING';
    }
  });
  if (run.updatedAt !== snapshot.events.at(-1)!.timestamp) throw new Error('Workflow updatedAt must match the last journal event.');
  if (INTEGER_USAGE_FIELDS.some(field => replayedUsage[field] !== run.usage[field]) || replayedUsage.estimatedCost !== run.usage.estimatedCost) throw new Error('Workflow usage projection does not match the journal.');
  const replayed = run.acceptanceCriteria.filter(criterion => satisfied.has(criterion));
  if (replayed.length !== run.satisfiedCriteria.length || replayed.some((criterion, index) => criterion !== run.satisfiedCriteria[index])) throw new Error('Satisfied criteria projection does not match the journal.');

  const commitment = snapshot.commitment;
  if (commitment) {
    if (!['REQUESTED', 'ACCEPTED', 'REJECTED', 'CANCELLED'].includes(commitment.status)) throw new Error('Commitment status is invalid.');
    if (!commitment.commitmentId?.trim()) throw new Error('Commitment ID is required.');
    if (!run.participantAgentIds.includes(commitment.requestedByAgentId)) throw new Error('Commitment requester must be a workflow participant.');
    if (commitment.summary !== undefined && !commitment.summary.trim()) throw new Error('Commitment summary cannot be empty.');
    if (commitment.evidenceRefs) validateStringArray(commitment.evidenceRefs, 'commitment evidenceRefs');
    if (commitment.status === 'REQUESTED' && (commitment.decidedByAgentId !== undefined || commitment.decidedAt !== undefined || commitment.rejectionReason !== undefined)) throw new Error('Requested commitment cannot contain decision metadata.');
    if (commitment.status === 'ACCEPTED' && (commitment.decidedByAgentId !== run.supervisorAgentId || commitment.decidedAt === undefined || run.status !== 'RESOLVED')) throw new Error('Accepted commitment requires supervisor decision and resolved workflow.');
    if (commitment.status === 'REJECTED' && (commitment.decidedByAgentId !== run.supervisorAgentId || commitment.decidedAt === undefined || !commitment.rejectionReason?.trim())) throw new Error('Rejected commitment requires supervisor decision and reason.');
    if (commitment.status === 'CANCELLED' && run.status !== 'CANCELLED') throw new Error('Cancelled commitment requires cancelled workflow.');
  }
  if (!commitmentsEqual(replayedCommitment, commitment)) throw new Error('Commitment projection does not match the journal.');
  if (run.status === 'RESOLVED' && commitment?.status !== 'ACCEPTED') throw new Error('Resolved workflow requires an accepted commitment.');
  if (commitment?.status === 'ACCEPTED' && run.status !== 'RESOLVED') throw new Error('Accepted commitment requires a resolved workflow.');
  if (run.status === 'RESOLVED' && snapshot.policy.completionRules.requireAllAcceptanceCriteria && run.satisfiedCriteria.length !== run.acceptanceCriteria.length) throw new Error('Resolved workflow requires all acceptance criteria.');
  for (const session of Object.values(snapshot.sessions)) {
    if (!['map.coord.task.v1', 'map.coord.decision.v1', 'map.coord.quorum.v1'].includes(session.mode)) throw new Error('Session mode is invalid.');
    if (!['OPEN', 'SUSPENDED', 'RESOLVED', 'CANCELLED', 'EXPIRED'].includes(session.state)) throw new Error('Session state is invalid.');
    const sessionParticipants = validateStringArray(session.participants, 'session participants'); if (!sessionParticipants.length) throw new Error('Session requires participants.');
    if (!session.goal?.trim()) throw new Error('Session goal is required.');
    if (!Number.isFinite(session.createdAt) || !Number.isFinite(session.updatedAt) || session.createdAt < run.createdAt
      || session.createdAt > session.updatedAt || session.updatedAt > run.updatedAt) throw new Error('Session timestamps are invalid.');
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
    if (!['ASSIGNED', 'COMPLETED', 'FAILED', 'CANCELLED'].includes(task.status)) throw new Error('Task status is invalid.');
    if (!Number.isFinite(task.createdAt) || !Number.isFinite(task.updatedAt) || task.createdAt < run.createdAt
      || task.createdAt > task.updatedAt || task.updatedAt > run.updatedAt) throw new Error('Task timestamps are invalid.');
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
    if (!Number.isFinite(decision.createdAt) || !Number.isFinite(decision.updatedAt) || decision.createdAt < run.createdAt
      || decision.createdAt > decision.updatedAt || decision.updatedAt > run.updatedAt) throw new Error('Decision timestamps are invalid.');
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
    if (!Number.isFinite(quorum.createdAt) || !Number.isFinite(quorum.updatedAt) || quorum.createdAt < run.createdAt
      || quorum.createdAt > quorum.updatedAt || quorum.updatedAt > run.updatedAt) throw new Error('Quorum timestamps are invalid.');
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
    if (!Number.isFinite(evaluation.createdAt) || evaluation.createdAt < run.createdAt || evaluation.createdAt > run.updatedAt) throw new Error('Evaluation timestamp is invalid.');
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
  if (replayedWorkflowStatus !== run.status) throw new Error('Workflow status projection does not match the journal.');
};
