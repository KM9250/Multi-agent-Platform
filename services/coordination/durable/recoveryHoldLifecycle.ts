import type { DurableTransaction, Row } from './db';
import { DurableStoreError, requireIntegrity } from './integrity';

export function readWorkflowControl(tx: DurableTransaction, id: string): Row {
  const c = tx.get('SELECT * FROM recovery_workflow_control WHERE workflow_run_id=?', id);
  const h = tx.get('SELECT * FROM recovery_hold_lifecycle WHERE workflow_run_id=? ORDER BY control_revision DESC LIMIT 1', id);
  requireIntegrity(c && h && ['hold_epoch','control_revision','hold_state','active_invocation_id','planning_review_pending'].every(k=>c[k]===h[k]));
  return c;
}
export function assertLegacyControl(tx: DurableTransaction, id: string, table: string, planId: string): void {
  const c = readWorkflowControl(tx,id);
  const b = tx.get('SELECT * FROM recovery_legacy_control_bindings WHERE plan_table=? AND plan_id=? AND workflow_run_id=?',table,planId,id);
  if (c.hold_state!=='HELD' || !b || b.hold_epoch!==c.hold_epoch || b.control_revision!==c.control_revision || c.active_invocation_id || c.planning_review_pending)
    throw new DurableStoreError('RECOVERY_INVALID_PLAN');
}
