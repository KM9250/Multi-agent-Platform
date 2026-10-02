import { findExhaustedBudget } from './policy';
import type { CommitmentGateResult, CoordinationSnapshot } from './types';
import { validateCoordinationSnapshot } from './validation';

/** Pure, deterministic eligibility check for final workflow commitment. */
export const evaluateCommitmentGate = (snapshot: CoordinationSnapshot, now: number): CommitmentGateResult => {
  try {
    validateCoordinationSnapshot(snapshot);
    const activeSessionIds = Object.values(snapshot.sessions)
      .filter(session => session.state === 'OPEN' || session.state === 'SUSPENDED')
      .map(session => session.sessionId).sort();
    const satisfied = new Set(snapshot.run.satisfiedCriteria);
    const missingCriteria = snapshot.run.acceptanceCriteria.filter(criterion => !satisfied.has(criterion));
    const reasons: string[] = [];
    if (snapshot.run.status !== 'RUNNING') reasons.push('workflow-not-running');
    if (activeSessionIds.length) reasons.push('active-sessions');
    if (snapshot.policy.completionRules.requireAllAcceptanceCriteria && missingCriteria.length) reasons.push('missing-acceptance-criteria');
    const exhaustedBudget = findExhaustedBudget(snapshot.run.budget, snapshot.run.usage, Math.max(0, now - snapshot.run.createdAt));
    return { allowed: reasons.length === 0, activeSessionIds, missingCriteria, exhaustedBudget, reasons };
  } catch {
    return { allowed: false, activeSessionIds: [], missingCriteria: [], reasons: ['snapshot-invalid'] };
  }
};

export const commitmentGateResultsEqual = (a: CommitmentGateResult, b: CommitmentGateResult): boolean =>
  a.allowed === b.allowed && a.exhaustedBudget === b.exhaustedBudget
  && a.activeSessionIds.length === b.activeSessionIds.length && a.activeSessionIds.every((v, i) => v === b.activeSessionIds[i])
  && a.missingCriteria.length === b.missingCriteria.length && a.missingCriteria.every((v, i) => v === b.missingCriteria[i])
  && a.reasons.length === b.reasons.length && a.reasons.every((v, i) => v === b.reasons[i]);
