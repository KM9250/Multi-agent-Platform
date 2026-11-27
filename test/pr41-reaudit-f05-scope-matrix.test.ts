import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { appFixture } from "./app-data-fixture.ts";
import { PUBLIC_USER_OPERATIONS } from "../server/auth/authorization.ts";
import { createAiSearchBinding } from "../server/search/ai-binding.ts";
import { SearchSources } from "../server/search/sources.ts";

const observations: unknown[] = [];
const evidence = process.env.PR41_AUDIT_EVIDENCE_DIR ?? "/tmp/pr41-reaudit-evidence";

function setup(t: any, scenario: { send: "public" | "empty" | "private" | "other-provider"; read?: boolean; enabled?: boolean }) {
  const f = appFixture();
  t.after(async () => { await f.generation.shutdown(); f.dispose(); });
  const owner = f.repository.createPersona(f.actor, f.room.id, { name: "source-owner", model: "synthetic" });
  if (scenario.enabled === false)
    f.repository.updatePersona(f.actor, f.room.id, owner.id, { expectedRevision: 1, isEnabled: false });
  const source = f.repository.appendMessage(f.actor, f.room.id, { role: "model", personaId: owner.id, content: "scope matrix original" });
  const actor = { workspaceId: f.actor.workspaceId, actorId: "scope-matrix-reader" };
  f.app.db.prepare("INSERT INTO principals VALUES(?,?,1)").run(actor.actorId, actor.workspaceId);
  for (const operation of PUBLIC_USER_OPERATIONS) if (!["READ_CONVERSATION", "SEND_TO_PROVIDER"].includes(operation))
    f.policy.grant(actor.actorId, actor.workspaceId, operation);
  const grant = (operation: string, personaId: string, visibility: string, provider?: string) =>
    f.policy.grant(actor.actorId, actor.workspaceId, operation, { roomId: f.room.id, personaId, visibility, ...(provider ? { provider } : {}) });
  grant("READ_CONVERSATION", "", "");
  grant("READ_CONVERSATION", "", "public");
  grant("READ_CONVERSATION", f.persona.id, "public");
  if (scenario.read !== false) grant("READ_CONVERSATION", owner.id, "public");
  grant("SEND_TO_PROVIDER", f.persona.id, "*", "synthetic");
  grant("SEND_TO_PROVIDER", owner.id, "", "synthetic");
  if (scenario.send !== "empty") grant("SEND_TO_PROVIDER", owner.id,
    scenario.send === "private" ? "self_only" : "public", scenario.send === "other-provider" ? "other-provider" : "synthetic");
  const run = f.generation.accept(actor, f.room.id, { requestId: randomUUID(),
    expectedRoomRevision: f.repository.getRoom(actor, f.room.id).revision,
    content: "以前の記録", recipient: { type: "agent", agentIds: [f.persona.id] }, context: { mode: "archive" } });
  f.app.db.prepare("UPDATE app_generation_runs SET state='RUNNING' WHERE run_id=?").run(run.runId);
  const binding = createAiSearchBinding(f.app, f.policy, actor, { runId: run.runId, planId: randomUUID(),
    consumerPersonaId: f.persona.id, provider: "synthetic", model: "synthetic" });
  const human = new SearchSources(f.app, f.policy, actor, f.room.id);
  const ai = new SearchSources(f.app, f.policy, actor, f.room.id, binding);
  let cursor: string | undefined;
  for (;;) { const page = human.archivePage(cursor); cursor = page.cursor; if (!page.hasMore) break; }
  assert.equal(ai.hasUnindexedChanges("archive", cursor), false);
  return { ...f, owner, source, human, ai, cursor };
}

test("PR41 re-audit F05: current grant metadata matches candidate scope across provider, visibility, READ and owner enabled cases", async t => {
  const cases = [
    { name: "allowed", send: "public" as const, expected: true },
    { name: "unspecified visibility", send: "empty" as const, expected: false },
    { name: "private-only visibility", send: "private" as const, expected: false },
    { name: "different provider", send: "other-provider" as const, expected: false },
    { name: "no source READ", send: "public" as const, read: false, expected: false },
    { name: "disabled source owner", send: "public" as const, enabled: false, expected: false },
  ];
  for (const c of cases) await t.test(c.name, t => {
    const f = setup(t, c);
    f.repository.appendRevision(f.actor, f.room.id, f.source.id, { expectedRevision: 1, reason: "regeneration", content: "scope matrix changed" });
    const allowed = f.ai.allowsScope("archive", f.owner.id, "public", "public_message");
    const lagging = f.ai.hasUnindexedChanges("archive", f.cursor);
    const humanLagging = f.human.hasUnindexedChanges("archive", f.cursor);
    observations.push({ case: c.name, allowed, lagging, humanLagging, realProviderCalls: f.provider.calls.length });
    assert.equal(allowed, c.expected);
    assert.equal(lagging, c.expected);
    assert.equal(humanLagging, c.read !== false);
    assert.equal(f.provider.calls.length, 0);
  });
});

test("PR41 re-audit F05: persona deletion freshness requires the removed source's READ and provider SEND scope", async t => {
  const cases = [
    { name: "allowed owner deletion", send: "public" as const, expected: true },
    { name: "unsendable owner deletion", send: "other-provider" as const, expected: false },
    { name: "unreadable owner deletion", send: "public" as const, read: false, expected: false },
  ];
  for (const c of cases) await t.test(c.name, t => {
    const f = setup(t, c);
    f.repository.deletePersona(f.actor, f.room.id, f.owner.id, { expectedRevision: 1 });
    const lagging = f.ai.hasUnindexedChanges("archive", f.cursor);
    observations.push({ case: c.name, lagging, realProviderCalls: f.provider.calls.length });
    assert.equal(lagging, c.expected);
    assert.equal(f.provider.calls.length, 0);
  });
  mkdirSync(evidence, { recursive: true });
  writeFileSync(`${evidence}/f05-scope-matrix.json`, JSON.stringify(observations, null, 2));
});
