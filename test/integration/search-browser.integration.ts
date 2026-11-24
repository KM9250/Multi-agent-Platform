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
  await target.selectOption("archive");
  await terms.fill(privateTerm);
  await panel.getByLabel("Conversation date (optional)").fill("2026-11-11");
  await panel.getByLabel("Time zone").fill("Asia/Tokyo");
  await panel.getByLabel("Persona", { exact: true }).selectOption(persona.id);
  assert.ok(
    !requests.some((url) => url.endsWith("/search")),
    "Typing must not dispatch a query",
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
