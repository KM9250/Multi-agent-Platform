import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { SessionService } from "../server/auth/sessions.ts";
import { startServer } from "../server/main.ts";
import type { MemoryCandidateDTO } from "../shared/memory-contracts.ts";
import { lineageFixture } from "./memory-lineage-fixture.ts";

test("PR39 F-06 normal Host advances persisted source checks, stops cleanly and resumes queued work", async (t) => {
  const f = lineageFixture();
  t.after(f.close);
  const sessions = new SessionService(f.app);
  const reader = await sessions.createAccount({
    username: "host-lineage-reader",
    password: "synthetic-reader-password",
    workspaceId: f.actor.workspaceId,
  });
  f.policy.grant(reader.actorId, reader.workspaceId, "READ_MEMORY", {
    roomId: f.room.id,
    personaId: f.persona.id,
    visibility: "persona_private",
  });
  const login = await sessions.login(
    "host-lineage-reader",
    "synthetic-reader-password",
  );
  for (let i = 0; i < 9; i++) await f.turn("Synthetic context " + i);
  const first = await f.memory();
  assert.equal(first.candidate.state, "LINEAGE_PENDING");
  const reserved = createServer();
  await new Promise<void>((resolve) =>
    reserved.listen(0, "127.0.0.1", resolve),
  );
  const port = (reserved.address() as AddressInfo).port;
  await new Promise<void>((resolve) => reserved.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const config = {
    MAP_DATA_ROOT: f.root,
    MAP_DEV_HTTP: "1",
    MAP_HOST: "127.0.0.1",
    MAP_ORIGIN: origin,
    MAP_PORT: String(port),
    MAP_PROVIDER: "fake",
  };

  async function awaitReviewable(candidateId: string) {
    const deadline = Date.now() + 10000;
    while (true) {
      const response = await fetch(
        origin +
          "/api/app/v1/rooms/" +
          f.room.id +
          "/memory/candidates/" +
          candidateId,
        {
          headers: { cookie: "map_session=" + login.token },
        },
      );
      assert.equal(response.status, 200);
      const candidate = (await response.json()) as MemoryCandidateDTO;
      if (candidate.state === "PENDING_REVIEW") {
        assert.ok(candidate.body.length > 0);
        assert.equal(candidate.rechecking, undefined);
        return;
      }
      assert.equal(candidate.state, "LINEAGE_PENDING");
      assert.equal(candidate.body, "");
      assert.ok(
        Date.now() < deadline,
        "Host worker did not finish source verification",
      );
      await delay(50);
    }
  }

  async function serve(candidateId: string) {
    const host = await startServer(config);
    try {
      await awaitReviewable(candidateId);
    } finally {
      await host.close();
    }
    assert.equal(host.server.listening, false);
  }

  await serve(first.candidate.id);
  const later = await f.memory();
  const persisted = () =>
    f.app.db
      .prepare(
        "SELECT calls_done,status FROM memory_lineage_work WHERE candidate_id=?",
      )
      .get(later.candidate.id);
  const stopped = persisted();
  assert.equal(later.candidate.state, "LINEAGE_PENDING");
  assert.equal(stopped!.status, "PENDING");
  // Stay stopped for longer than an idle worker interval before opening the same root again.
  await delay(600);
  assert.deepEqual(persisted(), stopped);
  await serve(later.candidate.id);
  assert.equal(persisted()!.status, "DONE");
  assert.equal(
    f.app.db.prepare("SELECT count(*) n FROM app_provider_calls").get()!.n,
    11,
  );
  assert.equal(
    f.app.db.prepare("SELECT count(*) n FROM memory_jobs").get()!.n,
    0,
  );
});
