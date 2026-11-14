import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { continuationFixture, content } from './continuation-fixture.ts';
import { completeClaim, reconciliationContents, reconciliationFixture, signedSyntheticVerifier, syntheticSource, tableCount } from './reconciliation-fixture.ts';
import { ModelCallLedger } from '../services/coordination/durable/modelCallLedger.ts';
import { ReconciliationEvidenceService } from '../services/coordination/durable/reconciliationEvidenceStore.ts';
import { ReconciliationPlanner } from '../services/coordination/durable/reconciliationPlanner.ts';
import { ReconciliationAuthorizer, reconciliationScopeOf } from '../services/coordination/durable/reconciliationAuthorizer.ts';
import { ReconciliationExecutor } from '../services/coordination/durable/reconciliationExecutor.ts';
import { ReconciliationReader } from '../services/coordination/durable/reconciliationReader.ts';
import { readReconciliationTarget } from '../services/coordination/durable/reconciliationVerifier.ts';
import type { ReconciliationPolicy, ReconciliationTarget } from '../services/coordination/durable/reconciliationTypes.ts';
import { DATABASE_NOW_SQL } from '../services/coordination/durable/leaseSchema.ts';

test('IN-08: actual committed Verification expiry preserves its authenticated Receipt, accounting and original history without a Generation change', async t => {
  const f = reconciliationFixture(t), model = f.model();
  const { verification } = await f.verified(model.target, completeClaim(), { expiresAt: Date.now() + 1500 });
  const plan = f.plan(model.target, verification.verificationId), grant = f.authorize(plan), receipt = f.execute(plan);
  assert.ok(receipt.committedAt < verification.expiresAt);
  const reader = new ReconciliationReader(f.db), inspection = reader.inspect(model.target, f.credential);
  const budget = model.ledger.getBudgetPosition('run'), before = reconciliationContents(f.raw), calls = { ...f.counts };
  assert.deepEqual(budget.committed, { llmCalls: 1, inputTokens: 200, outputTokens: 200, costMicros: 400 });
  assert.equal(budget.outstanding.llmCalls, 0);
  const generation = f.lease.generation;

  await delay(Math.max(0, verification.expiresAt - Date.now()) + 30);
  assert.ok(Date.now() > verification.expiresAt);
  // Only the Verification has expired: no revoked trust, expired Grant/Plan or new owner is involved.
  assert.ok(Date.now() < Math.min(plan.expiresAt, grant.expiresAt));
  assert.equal(f.lease.generation, generation);
  assert.deepEqual(f.api().evidence.readVerification(verification.verificationId, f.credential), verification);
  assert.deepEqual(new ReconciliationExecutor(f.db).inspectReceipt(plan.planId, f.credential), receipt);
  assert.deepEqual(f.execute(plan), receipt);
  assert.deepEqual(reader.inspect(model.target, f.credential), inspection);
  assert.deepEqual(model.ledger.getBudgetPosition('run'), budget);
  assert.equal(tableCount(f.raw, 'reconciliation_disputes'), 0);
  assert.equal(tableCount(f.raw, 'model_usage_authorities'), 1);
  assert.equal(f.raw.prepare('SELECT status FROM reconciliation_grants WHERE grant_id=?').get(grant.grantId)!.status, 'CONSUMED');
  assert.deepEqual(reconciliationContents(f.raw), before);
  assert.deepEqual(f.counts, calls);
  assert.equal(f.counts.action, 0);
  assert.equal(f.counts.model, 0);
});

test('US-12: actual original Invocation deadline expiry rejects old settlement before effects, then new authenticated 4C approval settles without rewriting deadlines or consumed debits', async t => {
  const synthetic = signedSyntheticVerifier();
  synthetic.binding.pricingIds = ['synthetic-price-v1', 'test:1'];
  const policy: ReconciliationPolicy = {
    version: 'synthetic-policy:1', authorityDomain: syntheticSource.authorityDomain,
    approvals: { SETTLE_VERIFIED_MODEL_USAGE: { minimumApprovers: 1, forbidSelfApproval: true } },
    canAccess: () => true, inspectContent: () => true,
  };
  const f = continuationFixture(t, {
    admissionMs: 1000, modelTimeoutMs: 1000, actionTimeoutMs: 100, readTimeoutMs: 100,
    collectionGraceMs: 50, finalizationMs: 50,
  }, undefined, { policy, verifiers: { get: id => id === synthetic.binding.verifierId ? synthetic.binding : undefined } });
  const originalLease = f.lease, usage = { llmCalls: 1, inputTokens: 2, outputTokens: 3, estimatedCost: 0 };
  const preserved = () => ({
    ledger: f.raw.prepare('SELECT * FROM model_call_ledger').all(),
    attempts: f.raw.prepare('SELECT * FROM model_call_attempts').all(),
    journal: f.raw.prepare('SELECT * FROM journal_events').all(),
    debits: f.raw.prepare('SELECT * FROM recovery_invocation_debits').all(),
    steps: f.raw.prepare('SELECT * FROM recovery_invocation_steps').all(),
    grants: f.raw.prepare('SELECT * FROM recovery_continuation_grants').all(),
    artifacts: f.raw.prepare('SELECT * FROM planning_artifacts').all(),
  });
  let beforeLateResponse: ReturnType<typeof preserved> | undefined;
  let deadline = 0;
  f.hook(async () => {
    const invocation = f.raw.prepare('SELECT * FROM recovery_invocations').get()!;
    assert.equal(invocation.status, 'ACTIVE');
    const step = f.raw.prepare("SELECT execution_deadline,collection_deadline FROM recovery_invocation_steps WHERE kind='MODEL'").get()!;
    const now = Number(f.raw.prepare(`SELECT ${DATABASE_NOW_SQL} AS now`).get()!.now);
    assert.ok(now < Math.min(Number(invocation.admission_deadline), Number(step.execution_deadline)),
      'Provider must enter before both persisted admission and execution deadlines');
    deadline = Number(invocation.collection_deadline);
    // Simulate a synchronous adapter returning after every persisted Invocation/Step deadline.
    // This is elapsed wall time, with neither clock replacement nor a Generation change.
    const remaining = deadline - now + 100;
    assert.ok(remaining > 0 && remaining <= 2200);
    const until = performance.now() + remaining;
    while (performance.now() < until) { /* deliberately late external response */ }
    assert.ok(Number(f.raw.prepare(`SELECT ${DATABASE_NOW_SQL} AS now`).get()!.now) > Math.max(deadline, Number(step.collection_deadline)));
    beforeLateResponse = preserved();
    return { value: { kind: 'plan', artifact: content }, usage, completeness: 'COMPLETE' };
  });
  const originalPlan = f.api().createPlan(f.input(), f.credential);
  const initial = await f.api().startAuthorized(originalPlan.planId, f.credential);
  assert.ok(deadline > 0 && Date.now() > deadline);
  assert.equal(f.lease.generation, originalLease.generation);
  assert.equal(initial.invocation?.status, 'REVIEW_REQUIRED');
  assert.equal(initial.invocation?.outcome, 'CONTINUATION_EXPIRED');
  assert.equal(initial.artifact, undefined);
  assert.equal(initial.counts.modelCalls, 1);
  assert.equal(initial.usage.committed.inputTokens, 0);
  assert.equal(initial.usage.outstanding.inputTokens, 20);
  assert.ok(beforeLateResponse);
  assert.deepEqual(preserved(), beforeLateResponse);
  assert.equal(tableCount(f.raw, 'model_usage_authorities'), 0);
  const row = f.raw.prepare('SELECT * FROM model_call_ledger').get()!;
  assert.equal(row.state, 'DISPATCH_INTENT');
  const target: ReconciliationTarget = { workflowRunId: 'run', targetKind: 'MODEL', targetId: String(row.model_call_id), attemptId: String(row.attempt_id) };
  const identity = { workflowRunId: 'run', modelCallId: target.targetId, attemptId: target.attemptId, providerId: String(row.provider_id), modelId: String(row.model_id) };
  const oldLedger = new ModelCallLedger(f.store), refused = reconciliationContents(f.raw), calls = { ...f.counts };
  // The raw deadline-trigger refusal is intentionally reduced to DATABASE_ERROR by the ordinary DB API.
  assert.throws(() => oldLedger.settle(identity, usage, true), { code: 'DATABASE_ERROR' });
  assert.deepEqual(reconciliationContents(f.raw), refused);
  assert.deepEqual(f.counts, calls);

  const originalInvocation = f.raw.prepare('SELECT * FROM recovery_invocations').all();
  const originalHistory = preserved();
  f.reacquire();
  assert.ok(f.lease.generation > originalLease.generation);
  const service = new ReconciliationEvidenceService(f.db, f.lease);
  const targetState = f.db.read(tx => readReconciliationTarget(tx, target));
  const evidence = service.submitCandidate({ target, contentType: 'application/json', dataClass: 'synthetic', body: synthetic.sign({
    target, targetDigest: targetState.targetDigest,
    source: { ...syntheticSource, externalOperationId: 'expired-invocation-model', effectUnit: 'model-usage' },
    claim: { ...completeClaim(), pricingId: 'test:1', usage, responseState: 'UNAVAILABLE_REVIEW_REQUIRED' },
    status: 'VERIFIED', reasonCodes: [], expiresAt: Date.now() + 600_000,
  }) }, f.credential);
  const verification = await service.verify({ evidenceId: evidence.evidenceId, verifierId: synthetic.binding.verifierId }, f.credential);
  const plan = new ReconciliationPlanner(f.db, f.lease).createPlan({ target, operationKind: 'SETTLE_VERIFIED_MODEL_USAGE', verificationId: verification.verificationId }, f.credential);
  assert.ok(plan.createdAt > deadline);
  assert.equal(plan.runtimeGeneration, f.lease.generation);
  const executor = new ReconciliationExecutor(f.db, f.lease), unauthorized = reconciliationContents(f.raw);
  assert.throws(() => executor.executeAuthorized(plan.planId, f.credential));
  assert.deepEqual(reconciliationContents(f.raw), unauthorized);
  assert.deepEqual(f.counts, calls);
  const grant = new ReconciliationAuthorizer(f.db, f.lease).authorize(plan.planId, reconciliationScopeOf(plan), f.approver);
  const receipt = executor.executeAuthorized(plan.planId, f.credential);
  assert.equal(receipt.status, 'COMMITTED');
  assert.ok(receipt.committedAt > deadline);
  const settled = f.api().inspect(originalPlan.planId, f.credential);
  assert.deepEqual(settled.invocation, initial.invocation);
  assert.equal(settled.counts.modelCalls, 1);
  assert.deepEqual(settled.usage, { committed: { inputTokens: 2, outputTokens: 3, costMicros: 0 }, outstanding: { inputTokens: 0, outputTokens: 0, costMicros: 0 } });
  assert.deepEqual(f.raw.prepare('SELECT * FROM recovery_invocations').all(), originalInvocation);
  assert.deepEqual(preserved(), originalHistory);
  assert.equal(f.raw.prepare('SELECT collection_deadline FROM recovery_invocations').get()!.collection_deadline, deadline);
  assert.equal(f.raw.prepare('SELECT status FROM reconciliation_grants WHERE grant_id=?').get(grant.grantId)!.status, 'CONSUMED');
  assert.equal(tableCount(f.raw, 'model_usage_authorities'), 1);
  assert.equal(tableCount(f.raw, 'reconciled_model_usages'), 1);
  assert.equal(f.raw.prepare('SELECT hold_state FROM recovery_workflow_control').get()!.hold_state, 'HELD');
  assert.equal(f.raw.prepare('SELECT response_status FROM reconciled_model_usages').get()!.response_status, 'UNAVAILABLE_REVIEW_REQUIRED');
  assert.deepEqual(f.counts, calls);
  assert.equal(f.counts.draft, 1);
  assert.equal(f.counts.action, 0);
  assert.equal(synthetic.counts.verifier, 1);
});
