/** App schema 7 additions. Released migration definitions remain immutable. */
export const CONTEXT_BUDGET_SCHEMA = `
CREATE TABLE app_context_answer_holds (
  plan_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, room_id TEXT NOT NULL,
  run_id TEXT NOT NULL, actor_id TEXT NOT NULL, consumer_persona_id TEXT NOT NULL,
  provider TEXT NOT NULL, model TEXT NOT NULL, binding_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('HELD','CONSUMED','RELEASED')),
  reserved_input_tokens INTEGER NOT NULL CHECK(reserved_input_tokens>0),
  reserved_output_tokens INTEGER NOT NULL CHECK(reserved_output_tokens>0),
  reserved_cost_micros INTEGER NOT NULL CHECK(reserved_cost_micros>=0),
  pricing_version TEXT NOT NULL, currency TEXT CHECK(currency IS NULL OR currency GLOB '[A-Z][A-Z][A-Z]'),
  search_profile_version INTEGER CHECK(search_profile_version IS NULL OR search_profile_version>0),
  call_id TEXT UNIQUE, created_at INTEGER NOT NULL, finished_at INTEGER,
  CHECK((state='CONSUMED' AND call_id IS NOT NULL) OR (state!='CONSUMED' AND call_id IS NULL)),
  FOREIGN KEY(workspace_id,room_id,run_id) REFERENCES app_generation_runs(workspace_id,room_id,run_id),
  FOREIGN KEY(workspace_id,actor_id) REFERENCES principals(workspace_id,actor_id),
  FOREIGN KEY(workspace_id,actor_id,room_id,search_profile_version)
    REFERENCES search_profiles(workspace_id,actor_id,room_id,version),
  FOREIGN KEY(workspace_id,room_id,consumer_persona_id) REFERENCES room_personas(workspace_id,room_id,persona_id),
  FOREIGN KEY(workspace_id,room_id,run_id,call_id,consumer_persona_id)
    REFERENCES app_provider_calls(workspace_id,room_id,run_id,call_id,persona_id)
) STRICT;
CREATE INDEX app_context_hold_run ON app_context_answer_holds(run_id,state);
CREATE TRIGGER app_context_hold_scope BEFORE INSERT ON app_context_answer_holds
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM app_generation_runs r
    WHERE r.workspace_id=NEW.workspace_id AND r.room_id=NEW.room_id AND r.run_id=NEW.run_id
      AND r.actor_id=NEW.actor_id) THEN RAISE(ABORT,'CONTEXT_HOLD_SCOPE') END;
  SELECT CASE WHEN NEW.state='CONSUMED' AND NOT EXISTS(SELECT 1 FROM app_provider_calls c
    WHERE c.call_id=NEW.call_id AND c.run_id=NEW.run_id AND c.persona_id=NEW.consumer_persona_id
      AND c.provider=NEW.provider AND c.model=NEW.model AND c.purpose='answer')
    THEN RAISE(ABORT,'CONTEXT_HOLD_CALL') END;
END;
CREATE TRIGGER app_context_hold_identity BEFORE UPDATE ON app_context_answer_holds
BEGIN
  SELECT CASE WHEN NEW.plan_id!=OLD.plan_id OR NEW.workspace_id!=OLD.workspace_id
    OR NEW.room_id!=OLD.room_id OR NEW.run_id!=OLD.run_id OR NEW.actor_id!=OLD.actor_id
    OR NEW.consumer_persona_id!=OLD.consumer_persona_id OR NEW.provider!=OLD.provider
    OR NEW.model!=OLD.model OR NEW.binding_digest!=OLD.binding_digest
    OR NEW.reserved_input_tokens!=OLD.reserved_input_tokens
    OR NEW.reserved_output_tokens!=OLD.reserved_output_tokens
    OR NEW.reserved_cost_micros!=OLD.reserved_cost_micros OR NEW.pricing_version!=OLD.pricing_version
    OR NEW.currency IS NOT OLD.currency OR NEW.search_profile_version IS NOT OLD.search_profile_version
    OR NEW.created_at!=OLD.created_at
    OR (OLD.state!='HELD' AND (NEW.state!=OLD.state OR NEW.call_id IS NOT OLD.call_id OR NEW.finished_at IS NOT OLD.finished_at))
    THEN RAISE(ABORT,'CONTEXT_HOLD_IMMUTABLE') END;
  SELECT CASE WHEN NEW.state='CONSUMED' AND NOT EXISTS(SELECT 1 FROM app_provider_calls c
    WHERE c.call_id=NEW.call_id AND c.run_id=NEW.run_id AND c.persona_id=NEW.consumer_persona_id
      AND c.provider=NEW.provider AND c.model=NEW.model AND c.purpose='answer')
    THEN RAISE(ABORT,'CONTEXT_HOLD_CALL') END;
END;
CREATE TABLE search_operation_bindings (
  operation_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose='answer'), binding_digest TEXT NOT NULL,
  FOREIGN KEY(operation_id) REFERENCES search_operations(operation_id),
  FOREIGN KEY(plan_id) REFERENCES app_context_answer_holds(plan_id),
  UNIQUE(plan_id,purpose)
) STRICT;
CREATE TRIGGER search_operation_binding_scope BEFORE INSERT ON search_operation_bindings
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM search_operations o JOIN app_context_answer_holds h
    ON h.workspace_id=o.workspace_id AND h.room_id=o.room_id AND h.actor_id=o.actor_id
    WHERE o.operation_id=NEW.operation_id AND h.plan_id=NEW.plan_id
      AND h.binding_digest=NEW.binding_digest AND h.state='HELD' AND o.purpose='QUERY_EMBEDDING'
      AND o.profile_version=h.search_profile_version)
    THEN RAISE(ABORT,'SEARCH_OPERATION_BINDING_SCOPE') END;
END;
CREATE TRIGGER search_operation_binding_immutable BEFORE UPDATE ON search_operation_bindings
BEGIN SELECT RAISE(ABORT,'SEARCH_OPERATION_BINDING_IMMUTABLE'); END;
`;
