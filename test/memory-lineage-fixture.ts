import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { AttachmentStore } from "../server/attachments/store.ts";
import { appFixture } from "./app-data-fixture.ts";
import { GenerationCoordinator } from "../server/generation/coordinator.ts";
import { FakeProvider } from "../server/generation/provider.ts";
import { MemoryCandidates } from "../server/memory/candidates.ts";
import { publishNext } from "../server/memory/worker.ts";
import { registerVault, setVaultPaused } from "../server/memory/vault.ts";

export function lineageFixture(options: { useDefaultPersona?: boolean } = {}) {
  const f = appFixture();
  const vault = mkdtempSync(join(tmpdir(), "map-lineage-vault-"));
  registerVault(f.app, vault);
  setVaultPaused(f.app, false);
  if (!options.useDefaultPersona) {
    f.repository.updatePersona(f.actor, f.room.id, f.persona.id, {
      expectedRevision: 1,
      historyWindow: 2,
      pinFirstMessage: false,
    });
  }
  const room = f.repository.updateRoom(f.actor, f.room.id, {
    expectedRevision: f.room.revision,
    internalStateSettings: { enabled: true },
  });
  const scope = {
    roomId: room.id,
    personaId: f.persona.id,
    visibility: "persona_private",
  };
  for (const operation of [
    "READ_MEMORY",
    "PROPOSE_MEMORY",
    "REVIEW_MEMORY",
    "PUBLISH_MEMORY",
  ]) {
    f.policy.grant(f.actor.actorId, f.actor.workspaceId, operation, scope);
  }
  f.policy.grant(f.actor.actorId, f.actor.workspaceId, "READ_PRIVATE_SEGMENT", {
    ...scope,
    visibility: "self_only",
  });
  const provider = new FakeProvider((request) => {
    const body = JSON.stringify(request.contents).includes("月曜")
      ? "予定は月曜"
      : "独立した記録";
    return {
      text: JSON.stringify(
        request.purpose === "memory"
          ? { memory_export: [{ visibility: "self_only", content: body }] }
          : { public_message: body },
      ),
      finish: "STOP",
      usage: {
        completeness: "COMPLETE",
        inputTokens: 2,
        outputTokens: 1,
        totalTokens: 3,
        semantics: "synthetic",
      },
    };
  });
  const attachmentStore = new AttachmentStore(f.app, f.policy);
  const generation = new GenerationCoordinator(f.app, f.repository, f.policy, {
    provider,
    defaultModel: "synthetic",
    attachmentStore,
  });
  const candidates = new MemoryCandidates(f.app, f.policy);
  async function turn(content: string, requestId: string = randomUUID()) {
    const run = generation.accept(f.actor, room.id, {
      requestId,
      expectedRoomRevision: room.revision,
      content,
      recipient: { type: "all" },
    });
    await generation.execute(run.runId);
    assert.equal(
      generation.get(f.actor, room.id, run.runId).status,
      "COMPLETED",
    );
    return run.runId;
  }
  async function memory(requestId?: string) {
    const runId = await turn("/memory", requestId);
    const receipt = f.app.db
      .prepare(
        "SELECT c.candidate_id,p.manifest_json,t.message_id FROM memory_candidates c JOIN app_provider_calls p USING(call_id) JOIN app_generation_receipts t USING(call_id) WHERE p.run_id=?",
      )
      .get(runId)!;
    const candidate = candidates.get(
      f.actor,
      room.id,
      String(receipt.candidate_id),
    );
    return {
      runId,
      candidate,
      noteId: candidate.binding.targetNoteId,
      outputId: String(receipt.message_id),
      manifestInputs: (
        JSON.parse(String(receipt.manifest_json)).messages as { id: string }[]
      ).map((ref) => ref.id),
    };
  }
  function publish(candidateId: string) {
    const candidate = candidates.get(f.actor, room.id, candidateId);
    candidates.review(f.actor, room.id, {
      requestId: randomUUID(),
      decision: "approve",
      items: [candidate.binding],
    });
    assert.equal(publishNext(f.app, f.policy), true);
  }
  function original() {
    return f.repository.appendMessage(f.actor, room.id, {
      role: "user",
      content: "予定は月曜",
    }).id;
  }
  function correct(messageId: string) {
    f.repository.correctMessage(f.actor, room.id, messageId, {
      expectedRevision: 1,
      content: "予定は火曜",
    });
  }
  function close() {
    f.dispose();
    rmSync(vault, { recursive: true, force: true });
  }
  return {
    ...f,
    attachmentStore,
    generation,
    provider,
    room,
    candidates,
    memory,
    turn,
    publish,
    original,
    correct,
    close,
    vault,
  };
}
