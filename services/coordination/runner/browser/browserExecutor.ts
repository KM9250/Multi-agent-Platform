import { defaultRunnerIds } from '../stores';
import type { PreparedRunnerAction, RunnerActionExecutor, RunnerClock, RunnerEvidenceStore, RunnerExecutionContext, RunnerExecutionResult, RunnerIdGenerator } from '../types';
import { BrowserBeforeDispatchError } from './browserDriver';
import { assessBrowserContent } from './contentTrust';
import { browserFingerprint, browserStateToken, canonicalSerialize, sha256 } from './fingerprint';
import { browserObservation } from './observation';
import { BrowserValidationError, normalizeBrowserCommand, record, reject, validateBrowserTarget, validateSurface } from './validation';
import type { BrowserContentTrustAssessment, BrowserPocDriver, BrowserPreparedPayloadV1, BrowserSurfaceSnapshot } from './types';

export function createBrowserPocExecutor(options: { driver: BrowserPocDriver; evidenceStore: RunnerEvidenceStore; ids?: RunnerIdGenerator; clock?: RunnerClock }): RunnerActionExecutor {
  const { driver, evidenceStore } = options;
  const ids = options.ids ?? defaultRunnerIds, clock = options.clock ?? { now: Date.now };
  const summary = (operation: string): string => ({ navigate: 'Navigate within the browser sandbox.', read: 'Read sandbox data.',
    input: 'Enter text into the sandbox search field.', interact: 'Interact with a sandbox control.', submit: 'Submit the local sandbox form.' })[operation]!;
  const failed = (errorCode: string): RunnerExecutionResult => ({ status: 'failed', summary: 'Browser action did not execute.', errorCode });
  async function hold(context: RunnerExecutionContext, assessment: BrowserContentTrustAssessment): Promise<RunnerExecutionResult> {
    const reviewFingerprint = await sha256({ workflowRunId: context.workflowRunId, taskId: context.taskId, nonce: globalThis.crypto.randomUUID() });
    const reviewRef = `map.runner.security-review.v1:${[context.workflowRunId, context.taskId, reviewFingerprint].map(encodeURIComponent).join(':')}`;
    // Raw external text and form values are never stored on this path, including failure diagnostics.
    try { await evidenceStore.put({ kind: 'browser.trust-assessment.v1', createdAt: clock.now(), content: { ...assessment, reviewRef } }); } catch { /* Review remains mandatory if evidence storage is unavailable. */ }
    return { status: 'failed', summary: 'Browser content requires security review.', safetyHold: {
      kind: 'untrusted-content', reasonCode: 'CONTENT_REVIEW_REQUIRED', reviewRef, safeSummary: 'Untrusted content requires user review.',
    } };
  }
  return {
    id: 'browser',
    async prepare(proposal) {
      if (proposal.executorId !== 'browser') reject();
      const command = normalizeBrowserCommand(proposal.operation, proposal.arguments);
      const snapshot = await driver.inspect(); validateBrowserTarget(command, snapshot);
      const payload: BrowserPreparedPayloadV1 = { schemaVersion: 1, surfaceId: snapshot.surfaceId, operation: command.operation,
        stateToken: await browserStateToken(snapshot), command };
      return { actionId: ids.nextId('browser-action'), executorId: 'browser', operation: command.operation,
        actionClass: `browser.${command.operation}`, fingerprint: await browserFingerprint(payload), publicSummary: summary(command.operation),
        retrySafety: command.operation === 'read' ? 'safe' : 'never', payload };
    },
    async execute(action: PreparedRunnerAction, context): Promise<RunnerExecutionResult> {
      let payload: BrowserPreparedPayloadV1, current: BrowserSurfaceSnapshot;
      try {
        const v = record(action.payload), c = record(v.command);
        const { operation, ...args } = c;
        const command = normalizeBrowserCommand(operation, args);
        payload = { schemaVersion: 1, surfaceId: v.surfaceId as string, operation: command.operation, stateToken: v.stateToken as string, command };
        if (v.schemaVersion !== 1 || v.operation !== command.operation || canonicalSerialize(payload) !== canonicalSerialize(v)
          || typeof v.stateToken !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(v.stateToken)
          || action.executorId !== 'browser' || action.operation !== command.operation || action.actionClass !== `browser.${command.operation}`
          || action.publicSummary !== summary(command.operation) || action.retrySafety !== (command.operation === 'read' ? 'safe' : 'never')
          || action.fingerprint !== await browserFingerprint(payload)) return failed('BROWSER_INVALID_PREPARED_ACTION');
        if (context.signal?.aborted) return failed('BROWSER_ABORTED_BEFORE_DISPATCH');
        current = await driver.inspect(); validateSurface(current);
        if (current.surfaceId !== payload.surfaceId || await browserStateToken(current) !== payload.stateToken) return failed('BROWSER_STALE_STATE');
        validateBrowserTarget(command, current);
      } catch (error) { return failed(error instanceof BrowserValidationError ? error.code : 'BROWSER_INVALID_PREPARED_ACTION'); }
      const beforeTrust = assessBrowserContent(browserObservation(current));
      if (beforeTrust.decision === 'NEEDS_REVIEW') return hold(context, beforeTrust);
      if (context.signal?.aborted) return failed('BROWSER_ABORTED_BEFORE_DISPATCH');
      let after: BrowserSurfaceSnapshot;
      try {
        const command = payload.command, guard = { expected: current };
        // Explicit dispatch keeps operation and target classification coupled.
        switch (command.operation) {
          case 'navigate': after = (await driver.navigate(command, context.signal, guard)).snapshot; break;
          case 'read': after = (await driver.read(command, context.signal, guard)).snapshot; break;
          case 'input': after = (await driver.input(command, context.signal, guard)).snapshot; break;
          case 'interact': after = (await driver.interact(command, context.signal, guard)).snapshot; break;
          case 'submit': after = (await driver.submit(command, context.signal, guard)).snapshot; break;
        }
        validateSurface(after);
        if (after.surfaceId !== payload.surfaceId) throw new Error('Unknown result surface.');
      } catch (error) {
        if (error instanceof BrowserBeforeDispatchError) return failed(error.code);
        return { status: 'uncertain', summary: 'Browser dispatch outcome could not be established.', errorCode: 'BROWSER_UNKNOWN_OUTCOME' };
      }
      const observation = browserObservation(after);
      const assessment = assessBrowserContent(observation);
      if (assessment.decision === 'NEEDS_REVIEW') return hold(context, assessment);
      try {
        const newStateToken = await browserStateToken(after);
        const kind = { navigate: 'navigation', read: 'observation', input: 'input', interact: 'interaction', submit: 'submission' }[payload.operation];
        const command = payload.command;
        const content = command.operation === 'read' ? browserObservation(after, command.targetId) : {
          surfaceId: after.surfaceId, pageId: after.pageId, operation: command.operation,
          ...('targetId' in command ? { targetId: command.targetId } : {}), previousStateToken: payload.stateToken,
          newStateToken, submitCount: after.submitCount, resultStatus: after.resultStatus,
        };
        const ref = await evidenceStore.put({ kind: `browser.${kind}.v1`, content, createdAt: clock.now() });
        const trustRef = await evidenceStore.put({ kind: 'browser.trust-assessment.v1', content: assessment, createdAt: clock.now() });
        if (!await evidenceStore.get(ref) || !await evidenceStore.get(trustRef)) throw new Error('Missing evidence.');
        return { status: 'succeeded', summary: 'Browser sandbox action completed.', evidenceRefs: [ref, trustRef] };
      } catch { return { status: 'failed', summary: 'Browser result evidence is unavailable.', errorCode: 'BROWSER_EVIDENCE_UNAVAILABLE' }; }
    },
  };
}
