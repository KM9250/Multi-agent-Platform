import type { CoordinationQuorum, QuorumThreshold } from './types';

export interface QuorumEvaluation {
  state: 'PENDING' | 'APPROVED' | 'REJECTED';
  requiredApprovals: number;
  approvals: number;
  castCount: number;
}

export const requiredQuorumApprovals = (threshold: QuorumThreshold, eligibleCount: number): number => {
  if (threshold.kind === 'all') return eligibleCount;
  if (threshold.kind === 'majority') return Math.floor(eligibleCount / 2) + 1;
  if (!Number.isInteger(threshold.count) || threshold.count < 1 || threshold.count > eligibleCount) {
    throw new Error('Quorum count threshold is invalid.');
  }
  return threshold.count;
};

export const evaluateQuorumOutcome = (quorum: CoordinationQuorum): QuorumEvaluation => {
  const requiredApprovals = requiredQuorumApprovals(quorum.threshold, quorum.eligibleAgentIds.length);
  const votes = Object.values(quorum.votes);
  const approvals = votes.filter(vote => vote === 'APPROVE').length;
  const castCount = votes.length;
  const state = approvals >= requiredApprovals ? 'APPROVED'
    : castCount === quorum.eligibleAgentIds.length ? 'REJECTED' : 'PENDING';
  return { state, requiredApprovals, approvals, castCount };
};
