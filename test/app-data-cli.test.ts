import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { AppDatabase } from "../server/app-data/db.ts";
import { SessionService } from "../server/auth/sessions.ts";
import { ConversationRepository } from "../server/app-data/repository.ts";
import { AuthorizationPolicy } from "../server/auth/authorization.ts";
import { hostConfiguration, startServer } from "../server/main.ts";
import { runCli } from "../server/cli.ts";

test("production fails closed without TLS/provider/account config; synthetic and unavailable modes require loopback development", () => {
  const common = {
    MAP_DATA_ROOT: "/tmp/config-only",
    MAP_ORIGIN: "https://app.example.test",
  };
  assert.throws(() => hostConfiguration(common), { code: "TLS_REQUIRED" });
  assert.throws(
    () => hostConfiguration({ ...common, MAP_TRUST_LOOPBACK_PROXY: "1" }),
    { code: "PROVIDER_CONFIGURATION_REQUIRED" },
  );
  assert.throws(
    () =>
      hostConfiguration({
        ...common,
        MAP_TRUST_LOOPBACK_PROXY: "1",
        MAP_HOST: "0.0.0.0",
      }),
    { code: "INVALID_CONFIGURATION" },
  );
  assert.throws(
    () =>
      hostConfiguration({
        ...common,
        MAP_DEV_HTTP: "1",
        MAP_PROVIDER: "fake",
        MAP_HOST: "0.0.0.0",
      }),
    { code: "INVALID_CONFIGURATION" },
  );
  const dev = hostConfiguration({
    ...common,
    MAP_ORIGIN: "http://127.0.0.1:3000",
    MAP_DEV_HTTP: "1",
    MAP_PROVIDER: "fake",
  });
  assert.equal(dev.port, 3001);
  assert.equal(dev.defaultModel, "synthetic");
  const unavailable = hostConfiguration({
    ...common,
    MAP_ORIGIN: "http://127.0.0.1:3000",
    MAP_DEV_HTTP: "1",
    MAP_PROVIDER: "unavailable",
  });
  assert.deepEqual(unavailable.allowedModels, []);
  assert.throws(
    () =>
      hostConfiguration({
        ...common,
        MAP_DATA_ROOT: resolve("runtime-data"),
        MAP_ORIGIN: "http://127.0.0.1:3000",
        MAP_DEV_HTTP: "1",
        MAP_PROVIDER: "fake",
      }),
    { code: "DATA_ROOT_OVERLAPS_SOURCE" },
  );
  assert.throws(
    () =>
      hostConfiguration({
        ...common,
        MAP_DATA_ROOT: "relative-data",
        MAP_ORIGIN: "http://127.0.0.1:3000",
        MAP_DEV_HTTP: "1",
        MAP_PROVIDER: "fake",
      }),
    { code: "ABSOLUTE_DATA_ROOT_REQUIRED" },
  );
});

test("host CLI backup, separate restore, credential reset and explicit resume preserve content without old sessions", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "map-cli-")),
    root = join(directory, "source"),
    backup = join(directory, "backup"),
    restored = join(directory, "restored");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cli = (args: string[], input?: string) => {
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-transform-types",
        "--loader",
        "./test/ts-loader.mjs",
        "server/cli.ts",
        ...args,
      ],
      { cwd: resolve("."), input, encoding: "utf8", timeout: 30000 },
    );
    return {
      ...result,
      value: result.stdout.trim() ? JSON.parse(result.stdout) : undefined,
    };
  };
  const created = cli(
    ["account-create", "--root", root, "--username", "restore-user"],
    "synthetic-account-password\n",
  );
  assert.equal(created.status, 0, created.stderr);
  const actor = created.value;
  const vault = join(directory, "dedicated-vault");
  const vaultCommand = (command: string, dataRoot = root, ...flags: string[]) =>
    runCli([command, "--root", dataRoot, ...flags]);
  assert.deepEqual(
    await vaultCommand(
      "vault-register",
      root,
      "--path",
      vault,
      "--trust-new",
      "true",
    ),
    { registered: true, paused: true, trustNew: true },
  );
  assert.deepEqual(await vaultCommand("vault-resume"), {
    registered: true,
    paused: false,
    trustNew: true,
  });
  const app = new AppDatabase({ root }),
    sessions = new SessionService(app),
    policy = new AuthorizationPolicy(app),
    repo = new ConversationRepository(app, policy),
    room = repo.createRoom(actor, { title: "restorable" });
  repo.appendMessage(actor, room.id, {
    role: "user",
    content: "saved original",
  });
  const persona = repo.createPersona(actor, room.id, {
    name: "Registrar",
    model: "synthetic",
  });
  const scope = {
    roomId: room.id,
    personaId: persona.id,
    visibility: "persona_private",
  };
  policy.grant(actor.actorId, actor.workspaceId, "MANAGE_VAULT");
  for (const op of ["READ_MEMORY", "REVIEW_MEMORY", "PUBLISH_MEMORY"])
    policy.grant(actor.actorId, actor.workspaceId, op, scope);
  const noteId = "mem_host_note";
  const handwritten =
    "---\nmap_id: mem_host_note\n---\nA synthetic standalone note.\n";
  const expectedDigest = createHash("sha256").update(handwritten).digest("hex");
  writeFileSync(join(vault, "manual.md"), handwritten, { mode: 0o600 });
  const registerNote = () =>
    vaultCommand(
      "vault-register-note",
      root,
      "--workspace",
      actor.workspaceId,
      "--actor",
      actor.actorId,
      "--room",
      room.id,
      "--persona",
      persona.id,
      "--visibility",
      scope.visibility,
      "--note",
      noteId,
      "--path",
      "manual.md",
      "--digest",
      expectedDigest,
      "--request",
      "host-manual-001",
      "--trusted",
      "true",
    );
  const old = await sessions.login(
    "restore-user",
    "synthetic-account-password",
  );
  app.close();
  assert.deepEqual(await registerNote(), {
    noteId,
    version: 1,
    digest: expectedDigest,
    state: "PUBLISHED",
  });
  assert.deepEqual(await registerNote(), {
    noteId,
    version: 1,
    digest: expectedDigest,
    state: "PUBLISHED",
  });
  const reserved = createServer();
  await new Promise<void>((r) => reserved.listen(0, "127.0.0.1", r));
  const port = (reserved.address() as any).port;
  await new Promise<void>((r) => reserved.close(() => r()));
  const origin = `http://127.0.0.1:${port}`;
  const config = {
    MAP_DATA_ROOT: root,
    MAP_ORIGIN: origin,
    MAP_PORT: String(port),
    MAP_DEV_HTTP: "1",
    MAP_PROVIDER: "fake",
  };
  await assert.rejects(startServer({ ...config, MAP_STATIC_ROOT: vault }), {
    code: "VAULT_OVERLAPS_STATIC",
  });
  const live = await startServer(config);
  try {
    await assert.rejects(vaultCommand("vault-pause"), {
      code: "HOST_IN_USE_OR_STALE_LOCK",
    });
    const response = await fetch(origin + "/api/app/v1/rooms", {
      headers: { cookie: `map_session=${old.token}` },
    });
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as any[])[0].title, "restorable");
  } finally {
    await live.close();
  }
  assert.deepEqual(await vaultCommand("vault-rescan"), { status: "COMPLETE" });
  assert.deepEqual(await vaultCommand("vault-pause"), {
    registered: true,
    paused: true,
    trustNew: true,
  });
  const health = cli(["status", "--root", root]);
  assert.equal(health.status, 0, health.stderr);
  const orphans = cli(["attachment-check", "--root", root]);
  assert.equal(orphans.status, 0, orphans.stderr);
  assert.deepEqual(orphans.value, { staging: [], orphans: [] });
  const backed = cli(["backup", "--root", root, "--destination", backup]);
  assert.equal(backed.status, 0, backed.stderr);
  assert.equal(backed.value.restoreTested, false);
  const copy = cli(["restore", "--source", backup, "--destination", restored]);
  assert.equal(copy.status, 0, copy.stderr);
  assert.equal(existsSync(join(restored, "RESTORED_DISABLED")), true);
  await assert.rejects(vaultCommand("vault-resume", restored), {
    code: "RESTORE_RESUME_REQUIRED",
  });
  const denied = cli(["resume", "--root", restored]);
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /RESTORE_CREDENTIAL_RESET_REQUIRED/);
  const reset = cli(
    ["password-reset", "--root", restored, "--actor", actor.actorId],
    "changed-restored-password\n",
  );
  assert.equal(reset.status, 0, reset.stderr);
  const resumed = cli(["resume", "--root", restored]);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(existsSync(join(restored, "RESTORED_DISABLED")), false);
  assert.deepEqual(await vaultCommand("vault-status", restored), {
    registered: true,
    paused: true,
    trustNew: true,
  });
  const restoredApp = new AppDatabase({ root: restored });
  try {
    const restoredSessions = new SessionService(restoredApp);
    assert.throws(() => restoredSessions.authenticate(old.token), {
      code: "UNAUTHENTICATED",
    });
    await assert.rejects(
      restoredSessions.login("restore-user", "synthetic-account-password"),
      { code: "LOGIN_FAILED" },
    );
    const current = await restoredSessions.login(
      "restore-user",
      "changed-restored-password",
    );
    const restoredRepo = new ConversationRepository(
      restoredApp,
      new AuthorizationPolicy(restoredApp),
    );
    assert.equal(
      restoredRepo.listMessages(current.actor, room.id).messages[0].content,
      "saved original",
    );
    assert.equal(
      restoredApp.db
        .prepare("SELECT count(*) AS n FROM app_provider_calls")
        .get()!.n,
      0,
    );
  } finally {
    restoredApp.close();
  }
});
