/** Browser → HTTP → generation receipt → review/outbox → editable Vault → authorized reader. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  mkdtempSync,
  readFileSync,
  renameSync,
  unlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import { AppDatabase } from "../../server/app-data/db.ts";
import { ConversationRepository } from "../../server/app-data/repository.ts";
import { AttachmentStore } from "../../server/attachments/store.ts";
import { AuthorizationPolicy } from "../../server/auth/authorization.ts";
import { SessionService } from "../../server/auth/sessions.ts";
import { GenerationCoordinator } from "../../server/generation/coordinator.ts";
import { FakeProvider } from "../../server/generation/provider.ts";
import { createAppHandler } from "../../server/http/server.ts";
import { registerVault, setVaultPaused } from "../../server/memory/vault.ts";
import { startPublicationWorker } from "../../server/memory/worker.ts";
import {
  registerHandwrittenNote,
  startVaultWatcher,
} from "../../server/memory/importer.ts";

const root = mkdtempSync(join(tmpdir(), "map-memory-browser-"));
const vault = join(root, "dedicated-vault");
const app = new AppDatabase({ root: join(root, "app") });
const sessions = new SessionService(app);
const policy = new AuthorizationPolicy(app);
const repository = new ConversationRepository(app, policy);
const attachments = new AttachmentStore(app, policy);
const provider = new FakeProvider(() => ({
  text: JSON.stringify({
    memory_export: [
      { visibility: "self_only", content: "Fixture event remembered." },
      { visibility: "self_only", content: "Fixture preference remembered." },
    ],
  }),
  finish: "STOP",
  usage: {
    inputTokens: 10,
    outputTokens: 2,
    totalTokens: 12,
    completeness: "COMPLETE",
    semantics: "synthetic-v1",
  },
}));
const generation = new GenerationCoordinator(app, repository, policy, {
  provider,
  defaultModel: "synthetic",
  attachmentStore: attachments,
});
const server = createServer();
let browser: Browser | undefined;
let stopPublisher: (() => void) | undefined;
let stopWatcher: (() => Promise<void>) | undefined;
const issues: string[] = [];

try {
  const username = "memory-reviewer",
    password = "synthetic-review-password";
  const actor = await sessions.createAccount({ username, password });
  const room = repository.createRoom(actor, {
    title: "Synthetic review room",
    internalStateSettings: { enabled: true },
  });
  const persona = repository.createPersona(actor, room.id, {
    name: "Review Persona",
    model: "synthetic",
  });
  const scope = {
    roomId: room.id,
    personaId: persona.id,
    visibility: "persona_private",
  };
  for (const op of [
    "PROPOSE_MEMORY",
    "READ_MEMORY",
    "EDIT_MEMORY",
    "REVIEW_MEMORY",
    "PUBLISH_MEMORY",
    "RETRACT_MEMORY",
  ]) {
    policy.grant(actor.actorId, actor.workspaceId, op, scope);
  }
  policy.grant(actor.actorId, actor.workspaceId, "READ_PRIVATE_SEGMENT", {
    ...scope,
    visibility: "self_only",
  });
  registerVault(app, vault, { trustNew: true });
  setVaultPaused(app, false);
  const manualPath = "Registered fixture.md";
  const manualFile = "---\nmap_id: manual_fixture\n---\nHandwritten fixture.\n";
  writeFileSync(join(vault, manualPath), manualFile, { mode: 0o600 });
  policy.grant(actor.actorId, actor.workspaceId, "MANAGE_VAULT");
  await registerHandwrittenNote(app, policy, actor, {
    roomId: room.id,
    personaId: persona.id,
    scope: "persona_private",
    noteId: "manual_fixture",
    relativePath: manualPath,
    requestId: "manual-registration",
    trusted: true,
    expectedDigest: createHash("sha256").update(manualFile).digest("hex"),
  });
  stopPublisher = startPublicationWorker(app, policy);
  stopWatcher = startVaultWatcher(app);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  server.on(
    "request",
    createAppHandler({
      app,
      policy,
      sessions,
      repository,
      attachments,
      generation,
      development: true,
      origin,
      staticRoot: resolve("dist"),
      allowedModels: ["synthetic"],
    }),
  );
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
  page.on("pageerror", (e) => issues.push(e.message));
  page.on("request", (r) => {
    if (!r.url().startsWith(origin + "/")) issues.push("External request");
  });
  await page.goto(origin);
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("heading", { name: "Synthetic review room", exact: true })
    .first()
    .waitFor();
  await page.getByLabel("Message", { exact: true }).fill(" /memory ");
  await page
    .getByText("Generate private memory candidates", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Room memory" });
  await panel.getByText("Fixture event remembered.", { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("region", { name: "Conversation" })
      .getByText("Fixture event remembered.")
      .count(),
    0,
  );
  const event = panel
    .locator("article")
    .filter({ hasText: "Fixture event remembered." });
  await event.getByText("Source and generation details").click();
  assert.ok((await event.innerText()).includes("message:"));
  await event.getByRole("button", { name: "Read source text" }).click();
  await event
    .locator("blockquote")
    .filter({ hasText: "Fixture event remembered." })
    .waitFor();
  await event.getByRole("button", { name: "Hide source text" }).click();
  await event.getByRole("button", { name: "Edit candidate" }).click();
  const edited =
    "Reviewed fixture <img src='https://example.invalid/external'>";
  await event.getByLabel("Candidate text").fill(edited);
  await event.getByLabel("Memory type").selectOption("episodic");
  await event.getByLabel("Claim type").selectOption("user_assertion");
  await event.getByRole("button", { name: "Save candidate" }).click();
  await panel.getByText(edited, { exact: true }).waitFor();
  const checkboxes = panel.getByRole("checkbox");
  assert.equal(await checkboxes.count(), 2);
  await checkboxes.nth(0).check();
  await checkboxes.nth(1).check();
  let interrupted = false;
  await page.route("**/memory/reviews", async (route) => {
    if (interrupted) return route.continue();
    interrupted = true;
    const response = await route.fetch();
    assert.equal(
      response.status(),
      200,
      "The batch must commit before losing the receipt",
    );
    await route.abort("failed");
  });
  await panel
    .getByRole("button", { name: "Approve selected (2)", exact: true })
    .click();
  await panel.getByRole("button", { name: "Retry same request" }).click();
  await panel
    .getByText("Approval saved. Each candidate shows its publication status.")
    .waitFor();
  await panel.getByText("Published", { exact: true }).nth(1).waitFor();
  await page.reload();
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  await panel.getByRole("button", { name: "Vault notes" }).click();
  const manual = panel.locator("article").filter({ hasText: manualPath });
  await manual.getByRole("button", { name: "View note" }).click();
  await manual.getByText("Note source", { exact: true }).click();
  await manual
    .getByText("Handwritten note · registered by " + actor.actorId, {
      exact: true,
    })
    .waitFor();
  await manual
    .getByText("Original file · " + manualPath + " (version 1)", {
      exact: true,
    })
    .waitFor();
  // Make the edit after the human saw V1 and before the HTTP handler reads the file.
  // The watcher is stopped so only the current-bound mutation can observe drift.
  await stopWatcher();
  stopWatcher = undefined;
  await manual.getByRole("button", { name: "Retract publication" }).click();
  const manualRetract = "**/memory/notes/manual_fixture/retract";
  const manualV2 = manualFile.replace(
    "Handwritten fixture.",
    "Edited handwritten fixture.",
  );
  await page.route(
    manualRetract,
    async (route) => {
      writeFileSync(join(vault, manualPath), manualV2);
      await route.continue();
    },
    { times: 1 },
  );
  const staleResponse = page.waitForResponse((r) =>
    r.url().endsWith("/memory/notes/manual_fixture/retract"),
  );
  await manual.getByRole("button", { name: "Confirm retraction" }).click();
  const stale = await staleResponse;
  assert.equal(
    stale.status(),
    409,
    "Retracting after a V1-to-V2 disk edit must conflict",
  );
  assert.equal((await stale.json()).error.code, "REVISION_CONFLICT");
  assert.equal(stale.request().postDataJSON().expectedState, "PUBLISHED");
  assert.equal(stale.request().postDataJSON().expectedVersion, 1);
  assert.equal(
    app.db
      .prepare(
        "SELECT COUNT(*) n FROM memory_retract_requests WHERE note_id='manual_fixture'",
      )
      .get()!.n,
    0,
  );
  await panel
    .getByText(
      "The saved state changed. Refresh and review the current version.",
    )
    .waitFor();
  await manual.getByText("Current text unavailable · File changed").waitFor();
  assert.equal(
    await manual.getByRole("button", { name: "Confirm retraction" }).count(),
    0,
  );
  assert.equal(readFileSync(join(vault, manualPath), "utf8"), manualV2);
  stopWatcher = startVaultWatcher(app);
  await manual.getByRole("heading", { name: "Current version 2" }).waitFor();
  await manual
    .getByText("Edited handwritten fixture.", { exact: true })
    .waitFor();
  await manual.getByRole("button", { name: "Retract publication" }).click();
  const currentResponse = page.waitForResponse((r) =>
    r.url().endsWith("/memory/notes/manual_fixture/retract"),
  );
  await manual.getByRole("button", { name: "Confirm retraction" }).click();
  const accepted = await currentResponse;
  assert.equal(accepted.status(), 200);
  assert.equal(accepted.request().postDataJSON().expectedState, "PUBLISHED");
  assert.equal(accepted.request().postDataJSON().expectedVersion, 2);
  assert.notEqual(
    accepted.request().postDataJSON().requestId,
    stale.request().postDataJSON().requestId,
  );
  await manual.getByText(/Retracted · Version 2/).waitFor();
  assert.equal(readFileSync(join(vault, manualPath), "utf8"), manualV2);
  const published = app.db
    .prepare(
      "SELECT relative_path FROM memory_documents WHERE candidate_id IN (SELECT candidate_id FROM memory_candidate_revisions WHERE body=?)",
    )
    .get(edited);
  assert.ok(published);
  const relative = String(published.relative_path);
  await panel
    .locator("article")
    .filter({ hasText: relative })
    .getByRole("button", { name: "View note" })
    .click();
  await panel.getByText(edited, { exact: true }).waitFor();
  const previous = readFileSync(join(vault, relative), "utf8");
  assert.ok(previous.includes(edited));
  const foreign = "Changed in the external Markdown editor.";
  const moved = join(dirname(relative), "Renamed fixture.md");
  writeFileSync(join(vault, relative), previous.replace(edited, foreign));
  renameSync(join(vault, relative), join(vault, moved));
  await panel.getByText(moved, { exact: true }).waitFor({ timeout: 30000 });
  await panel.getByText(foreign, { exact: true }).waitFor();
  await panel.getByRole("button", { name: "Version history" }).click();
  const versions = panel.getByLabel("View version");
  await versions.selectOption("1");
  await panel.getByRole("heading", { name: "Historical version 1" }).waitFor();
  await panel.getByText(edited, { exact: true }).waitFor();
  await versions.selectOption("");
  await panel.getByText(foreign, { exact: true }).waitFor();
  await panel.getByRole("button", { name: "Propose a change" }).click();
  const proposal = "An explicit proposal for the renamed fixture.";
  await panel.getByLabel("Proposed text for version 2").fill(proposal);
  await panel.getByRole("button", { name: "Save proposal" }).click();
  await panel.getByText("Change proposal saved for review.").waitFor();
  await panel.getByRole("button", { name: "Candidates", exact: true }).click();
  const proposed = panel.locator("article").filter({ hasText: proposal });
  await proposed.getByRole("checkbox").check();
  await panel
    .getByRole("button", { name: "Approve selected (1)", exact: true })
    .click();
  await proposed
    .getByText("Approved · apply in Obsidian", { exact: true })
    .waitFor();
  assert.ok(readFileSync(join(vault, moved), "utf8").includes(foreign));
  await panel.getByRole("button", { name: "Vault notes" }).click();
  const movedNote = panel.locator("article").filter({ hasText: moved });
  await movedNote.getByRole("button", { name: "Retract publication" }).click();
  unlinkSync(join(vault, moved));
  await movedNote
    .getByText("Current text unavailable · File missing", { exact: true })
    .waitFor();
  assert.equal(
    await movedNote
      .getByRole("button", { name: "Confirm retraction" })
      .isDisabled(),
    true,
  );
  await movedNote.getByRole("button", { name: "Cancel retraction" }).click();
  await movedNote.getByRole("button", { name: "Retract publication" }).click();
  await movedNote
    .getByText(
      "This withdraws the registered publication. The Vault file is preserved.",
    )
    .waitFor();
  const missingResponse = page.waitForResponse(
    (r) => r.url().includes("/memory/notes/") && r.url().endsWith("/retract"),
  );
  await movedNote.getByRole("button", { name: "Confirm retraction" }).click();
  const missing = await missingResponse;
  assert.equal(missing.status(), 200);
  assert.equal(missing.request().postDataJSON().expectedState, "DELETED");
  await movedNote.getByText(/Retracted · Version 2/).waitFor();
  assert.equal(await movedNote.getByText(foreign, { exact: true }).count(), 0);
  const storage = await page.evaluate(async () => ({
    local: { ...localStorage },
    session: { ...sessionStorage },
    databases: await indexedDB.databases(),
  }));
  assert.deepEqual(storage, { local: {}, session: {}, databases: [] });
  assert.equal(provider.calls.length, 1);
  assert.equal(
    app.db.prepare("SELECT COUNT(*) AS n FROM memory_receipts").get()!.n,
    2,
  );
  assert.deepEqual(issues, []);
  console.log(
    JSON.stringify({
      suite: "memory-browser",
      passed: true,
      providerCalls: 1,
      receipts: 2,
      checks: [
        "scoped generation",
        "review and classify",
        "batch approval with lost ACK",
        "reload",
        "trusted file edit and rename",
        "historical version",
        "handwritten registrar and original version",
        "protected original source",
        "existing-note proposal preserved as reviewed text",
        "stale V1 retraction conflicts, V2 preserved and explicitly retracted",
        "retraction after known external deletion",
        "browser storage empty",
        "escaped Markdown",
      ],
    }),
  );
} finally {
  await browser?.close();
  if (server.listening)
    await new Promise<void>((ok) => server.close(() => ok()));
  stopPublisher?.();
  await stopWatcher?.();
  await generation.shutdown();
  app.close();
  rmSync(root, { recursive: true, force: true });
}
