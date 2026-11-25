/** B-01/B-02. Real Chromium, built frontend, authenticated HTTP and SQLite; all data is synthetic. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { AppDatabase } from "../../server/app-data/db.ts";
import { ConversationRepository } from "../../server/app-data/repository.ts";
import { AttachmentStore } from "../../server/attachments/store.ts";
import { AuthorizationPolicy } from "../../server/auth/authorization.ts";
import { SessionService } from "../../server/auth/sessions.ts";
import { GenerationCoordinator } from "../../server/generation/coordinator.ts";
import { FakeProvider } from "../../server/generation/provider.ts";
import { createAppHandler } from "../../server/http/server.ts";
import { requestIndexUpdate } from "../../server/search/index.ts";
import {
  configureSearchProfile,
  stopSearchProfile,
} from "../../server/search/profile.ts";

// This standalone suite exercises the missing-provider path on synthetic data.
delete process.env.GEMINI_API_KEY;
const root = mkdtempSync(join(tmpdir(), "map-search-browser-"));
const app = new AppDatabase({ root });
const policy = new AuthorizationPolicy(app);
const sessions = new SessionService(app);
const repository = new ConversationRepository(app, policy);
const attachments = new AttachmentStore(app, policy);
const provider = new FakeProvider();
const generation = new GenerationCoordinator(app, repository, policy, {
  provider,
  defaultModel: "synthetic",
  attachmentStore: attachments,
});
const privateTerm = `secret${randomUUID().replaceAll("-", "")}`;
const privateText = `${privateTerm} 猫 <img src="https://example.invalid/search-marker">`;
const password = "search browser fixture password";
const server = createServer();
let browser: Browser | undefined;

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}

async function storageEmpty(page: Page) {
  assert.deepEqual(
    await page.evaluate(async () => ({
      local: localStorage.length,
      session: sessionStorage.length,
      databases: await indexedDB.databases(),
      caches: await caches.keys(),
      workers: (await navigator.serviceWorker.getRegistrations()).length,
    })),
    { local: 0, session: 0, databases: [], caches: [], workers: 0 },
  );
}
try {
  const actor = await sessions.createAccount({
    username: "browser-reader",
    password,
  });
  const otherRoom = repository.createRoom(actor, { title: "Separate room" });
  const room = repository.createRoom(actor, { title: "Search fixture" });
  const persona = repository.createPersona(actor, room.id, {
    name: "Search Persona",
    model: "synthetic",
  });
  policy.grant(actor.actorId, actor.workspaceId, "READ_PRIVATE_SEGMENT", {
    roomId: room.id,
    personaId: persona.id,
    visibility: "self_only",
  });
  const embeddingScope = {
    roomId: room.id,
    personaId: persona.id,
    visibility: "room_shared",
  };
  policy.grant(actor.actorId, actor.workspaceId, "READ_MEMORY", embeddingScope);
  policy.grant(actor.actorId, actor.workspaceId, "SEND_TO_PROVIDER", {
    ...embeddingScope,
    provider: "google",
  });
  repository.appendMessage(actor, room.id, {
    role: "user",
    content: "Before the private marker",
    occurredAt: Date.parse("2026-11-09T09:00:00+09:00"),
  });
  repository.appendMessage(actor, room.id, {
    role: "model",
    personaId: persona.id,
    segments: [
      {
        channel: "public_message",
        visibility: "public",
        content: "Public acknowledgement",
      },
      {
        channel: "private_state",
        visibility: "self_only",
        content: privateText,
      },
    ],
    occurredAt: Date.parse("2026-11-09T09:02:00+09:00"),
  });
  await requestIndexUpdate(app, policy, actor, room.id, { rebuild: true });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  server.on(
    "request",
    createAppHandler({
      app,
      sessions,
      policy,
      repository,
      attachments,
      generation,
      origin,
      development: true,
      staticRoot: resolve("dist"),
      allowedModels: ["synthetic"],
    }),
  );
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({ timezoneId: "Asia/Tokyo" });
  const page = await context.newPage();
  const requests: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => requests.push(r.url()));
  await page.goto(origin);
  await page.getByLabel("Username", { exact: true }).fill("browser-reader");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("heading", { level: 4, name: "Search fixture", exact: true })
    .click();
  const openPanel = page.getByRole("button", {
    name: "Search room",
    exact: true,
  });
  await openPanel.click();
  const panel = page.getByRole("dialog", { name: "Search room" });
  const terms = panel.getByLabel("Search terms");
  const target = panel.getByLabel("Search in");
  const search = panel.getByRole("button", { name: "Search", exact: true });
  assert.equal(await target.inputValue(), "memory");
  assert.equal(await panel.getByLabel("Conversation revisions").count(), 0);
  const emptyMessage = panel.getByText(
    /No matching record was found within the saved records/,
  );
  const absentTerm = `absent${randomUUID().replaceAll("-", "")}`;
  await terms.fill(absentTerm);
  assert.ok(
    !requests.some((url) => url.endsWith("/search")),
    "Typing must not dispatch a query",
  );
  const memoryReply = page.waitForResponse((r) => r.url().endsWith("/search"));
  await search.click();
  const memoryResponse = await memoryReply;
  const local = await memoryResponse.json();
  assert.equal(local.status, "ready", JSON.stringify(local));
  assert.deepEqual(local.methods, ["lexical"]);
  assert.equal(local.external.calls, 0);
  assert.equal(memoryResponse.request().postDataJSON().retrievalMode, "auto");
  await panel.getByText("Search complete", { exact: true }).waitFor();
  await emptyMessage.waitFor();
  await panel.getByText(/Local text search.*No external calls/).waitFor();
  assert.equal(await panel.getByText("Reduced search coverage").count(), 0);

  // This time a real Host profile requests Dense search, but this process has no provider key.
  configureSearchProfile(app, actor, room.id, {
    personaId: persona.id,
    scopes: ["room_shared"],
    purposes: ["QUERY_EMBEDDING"],
    maxCalls: 1,
    maxTokens: 8192,
    maxCostMicros: 1000,
    priceMicrosPerThousandTokens: 1,
  });
  await requestIndexUpdate(app, policy, actor, room.id, { force: true });
  await search.click();
  await panel.getByText("Reduced search coverage").waitFor();
  await panel
    .getByText(/Dense search unavailable.*embedding provider is unconfigured/)
    .waitFor();
  await panel.getByText("Local text search returned no matches.").waitFor();
  await panel.getByText(/Local text search.*No external calls/).waitFor();
  assert.equal(await emptyMessage.count(), 0);
  stopSearchProfile(app, actor, room.id);

  // Place the changed Room between two unrelated runs longer than the old 32-event sample.
  // The intercepted lookup still uses the real HTTP handler, auth policy and index.
  function writeOtherRoomChanges() {
    for (let i = 0; i < 40; i++) {
      repository.appendMessage(actor, otherRoom.id, {
        role: "user",
        content: "Separate room update",
      });
    }
  }
  await target.selectOption("archive");
  await page.route(
    "**/rooms/*/search",
    async (route) => {
      await requestIndexUpdate(app, policy, actor, room.id, { force: true });
      writeOtherRoomChanges();
      repository.appendMessage(actor, room.id, {
        role: "user",
        content: "A recent schedule update.",
      });
      writeOtherRoomChanges();
      await route.continue();
    },
    { times: 1 },
  );
  const archiveReply = page.waitForResponse((r) => r.url().endsWith("/search"));
  await search.click();
  const stale = await (await archiveReply).json();
  assert.equal(stale.status, "partial", JSON.stringify(stale));
  assert.ok(stale.reasons.includes("INDEX_LAGGING"));
  await panel.getByText("Partial results", { exact: true }).waitFor();
  await panel
    .getByText(/Run the search again after the index synchronizes/)
    .waitFor();
  await panel
    .getByText("No verified matches are available in these partial results.")
    .waitFor();
  assert.equal(await emptyMessage.count(), 0);
  assert.equal(
    await panel.getByText("Search complete", { exact: true }).count(),
    0,
  );
  await requestIndexUpdate(app, policy, actor, room.id, { force: true });
  const submittedSearches = requests.filter((url) =>
    url.endsWith("/search"),
  ).length;
  await terms.fill(privateTerm);
  await panel.getByLabel("Conversation date (optional)").fill("2026-11-11");
  await panel.getByLabel("Time zone").fill("Asia/Tokyo");
  await panel.getByLabel("Persona", { exact: true }).selectOption(persona.id);
  assert.equal(
    requests.filter((url) => url.endsWith("/search")).length,
    submittedSearches,
    "Changing filters must not dispatch a query",
  );
  const dispatch = page.waitForResponse((r) => r.url().endsWith("/search"));
  await search.click();
  const answer = await dispatch;
  const body = await answer.json();
  assert.equal(answer.status(), 200, JSON.stringify(body));
  assert.ok(
    body.results.some(
      (row: { snippet: string }) => row.snippet === privateText,
    ),
    JSON.stringify(body),
  );
  assert.match(answer.headers()["cache-control"] || "", /no-store/);
  assert.equal(answer.request().method(), "POST");
  assert.equal(answer.request().postDataJSON().query, privateTerm);
  assert.ok(await answer.request().headerValue("x-csrf-token"));
  await panel.getByText(privateText, { exact: true }).waitFor();
  await panel.getByText(/Current version 1 · Original/).waitFor();
  await panel.getByText(/2026-11-04 through 2026-11-18/).waitFor();
  assert.equal(
    await panel
      .getByText(/Last completed sync/)
      .locator("time")
      .getAttribute("datetime"),
    new Date(body.coverage.syncedAt).toISOString(),
  );
  await panel
    .getByRole("button", { name: "Open surrounding messages" })
    .click();
  await panel
    .getByRole("region", { name: "Verified source" })
    .getByText(privateText, { exact: true })
    .waitFor();
  await panel
    .getByRole("heading", { name: "Verified source · Version 1 · Original" })
    .waitFor();
  assert.equal(await panel.locator("img").count(), 0);
  await storageEmpty(page);

  // A request in flight when the selected room changes must not populate the new panel.
  const gate = barrier();
  const started = barrier();
  const settled = barrier();
  await page.route(
    "**/rooms/*/search",
    async (route) => {
      try {
        const response = await route.fetch();
        started.resolve();
        await gate.promise;
        await route.fulfill({ response });
      } catch (error) {
        if (
          !String(error).match(
            /closed|aborted|canceled|Invalid InterceptionId/i,
          )
        )
          throw error;
      } finally {
        settled.resolve();
      }
    },
    { times: 1 },
  );
  await search.click();
  await started.promise;
  // The panel is modal. Deliver the same sidebar click handler while the request is pending.
  await page
    .getByRole("heading", { name: otherRoom.title, exact: true, level: 4 })
    .dispatchEvent("click");
  await page
    .getByRole("heading", { name: otherRoom.title, exact: true, level: 1 })
    .waitFor();
  await openPanel.click();
  gate.resolve();
  await settled.promise;
  assert.equal(await terms.inputValue(), "");
  assert.equal(await page.getByText(privateText, { exact: true }).count(), 0);

  await page.reload();
  await openPanel.click();
  assert.equal(await terms.inputValue(), "");
  assert.equal(await page.getByText(privateText, { exact: true }).count(), 0);
  await panel.getByRole("button", { name: "Close Search room" }).click();
  await page
    .getByRole("heading", { name: room.title, exact: true, level: 4 })
    .click();
  await page
    .getByRole("heading", { name: room.title, exact: true, level: 1 })
    .waitFor();
  await openPanel.click();
  await target.selectOption("archive");
  await terms.fill(privateTerm);
  await search.click();
  await panel.getByText(privateText, { exact: true }).waitFor();
  // A resync response can arrive from a citation read while earlier results are visible.
  await page.route(
    "**/search/citation",
    (route) =>
      route.fulfill({
        status: 409,
        json: { error: { code: "SEARCH_RESYNC_REQUIRED" } },
      }),
    { times: 1 },
  );
  await panel.getByRole("button", { name: "Open original" }).click();
  await panel
    .getByRole("alert")
    .filter({ hasText: "resynchronization" })
    .waitFor();
  assert.equal(await terms.inputValue(), "");
  assert.equal(await page.getByText(privateText, { exact: true }).count(), 0);
  await terms.fill(privateTerm);
  await search.click();
  await panel.getByText(privateText, { exact: true }).waitFor();
  const secondTab = await context.newPage();
  await secondTab.goto(origin);
  await secondTab.getByRole("button", { name: "Logout", exact: true }).click();
  await secondTab
    .getByRole("heading", { name: "Sign in", exact: true })
    .waitFor();
  await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
  assert.equal(await page.getByText(privateText, { exact: true }).count(), 0);
  assert.equal(await panel.count(), 0);
  await storageEmpty(page);

  assert.deepEqual(
    requests.filter(
      (url) => !url.startsWith(origin + "/") || url.includes(privateTerm),
    ),
    [],
  );
  assert.deepEqual(errors, []);
  assert.equal(provider.calls.length, 0);
  for (const asset of readdirSync(resolve("dist/assets"))) {
    if (!asset.endsWith(".js")) continue;
    const bundle = readFileSync(resolve("dist/assets", asset), "utf8");
    assert.doesNotMatch(
      bundle,
      /generativelanguage\.googleapis\.com|search_operations|gemini-embedding-2|\bAIza[0-9A-Za-z_-]{35}\b/,
    );
    assert.ok(!bundle.includes(privateTerm));
  }
  console.log(
    JSON.stringify({
      suite: "search-browser",
      passed: true,
      providerCalls: 0,
      checks: [
        "explicit search",
        "default local Memory empty search",
        "planned dense failure with no external provider",
        "partial result and retry guidance before archive synchronization",
        "authorized private excerpt",
        "date range",
        "resolved original",
        "room switch during delayed HTTP",
        "reload",
        "resync",
        "cross-tab logout",
        "browser stores and bundle",
      ],
    }),
  );
} finally {
  await browser?.close();
  if (server.listening)
    await new Promise<void>((ok) => server.close(() => ok()));
  await generation.shutdown();
  app.close();
  rmSync(root, { recursive: true, force: true });
}
