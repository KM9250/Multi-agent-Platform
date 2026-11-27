/** MEM-3A browser contract: synthetic provider, real HTTP/auth/SQLite and Chromium. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { AppDatabase } from "../../server/app-data/db.ts";
import { ConversationRepository } from "../../server/app-data/repository.ts";
import { AuthorizationPolicy } from "../../server/auth/authorization.ts";
import { SessionService } from "../../server/auth/sessions.ts";
import { AttachmentStore } from "../../server/attachments/store.ts";
import { GenerationCoordinator } from "../../server/generation/coordinator.ts";
import { FakeProvider } from "../../server/generation/provider.ts";
import { createAppHandler } from "../../server/http/server.ts";
import { requestIndexUpdate } from "../../server/search/index.ts";

delete process.env.GEMINI_API_KEY;
const root = mkdtempSync(join(tmpdir(), "map-context-browser-"));
const app = new AppDatabase({ root });
const policy = new AuthorizationPolicy(app);
const sessions = new SessionService(app);
const repository = new ConversationRepository(app, policy);
const attachments = new AttachmentStore(app, policy);
const provider = new FakeProvider(request => ({ text: request.structured
  ? JSON.stringify({ public_message: '星砂の記録 [[MAP_SOURCE:S1]] [[MAP_SOURCE:S999]] <img src="https://example.invalid/context-leak">' })
  : '星砂の記録 [[MAP_SOURCE:S1]] [[MAP_SOURCE:S999]] <img src="https://example.invalid/context-leak">',
  finish: "STOP", usage: { completeness: "COMPLETE", inputTokens: 10, outputTokens: 5, totalTokens: 15, semantics: "synthetic-v1" } }));
const generation = new GenerationCoordinator(app, repository, policy, { provider, defaultModel: "synthetic", attachmentStore: attachments });
const server = createServer();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const external: string[] = [];
const errors: string[] = [];
try {
  const password = "context browser synthetic password";
  const actor = await sessions.createAccount({ username: "context-reader", password });
  const other = repository.createRoom(actor, { title: "Other context room" });
  const room = repository.createRoom(actor, { title: "Context browser fixture", contextMode: "memory" });
  repository.createPersona(actor, room.id, { name: "Context Persona", model: "synthetic", historyWindow: 1, pinFirstMessage: false });
  const original = repository.appendMessage(actor, room.id, { role: "user", content: "星砂の記録😀\r\nOriginal exact source.", occurredAt: Date.UTC(2026, 10, 9) });
  await requestIndexUpdate(app, policy, actor, room.id, { rebuild: true });
  const accepted = generation.accept(actor, room.id, { requestId: randomUUID(), expectedRoomRevision: room.revision,
    content: "星砂の記録", context: { mode: "archive", timeZone: "Asia/Tokyo" }, recipient: { type: "all" } });
  await generation.execute(accepted.runId);
  assert.equal(generation.get(actor, room.id, accepted.runId).status, "COMPLETED");
  const answer = repository.listMessages(actor, room.id).messages.find(message => message.role === "model")!;
  assert.ok(answer.context?.supplied.length);
  await new Promise<void>(ok => server.listen(0, "127.0.0.1", ok));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  server.on("request", createAppHandler({ app, policy, sessions, repository, attachments, generation,
    origin, development: true, staticRoot: resolve("dist"), allowedModels: ["synthetic"] }));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
  const context = await browser.newContext({ timezoneId: "Asia/Tokyo" });
  context.on("request", request => { if (!request.url().startsWith(origin) && !request.url().startsWith("data:") && !request.url().startsWith("blob:")) external.push(request.url()); });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  await page.getByLabel("Username", { exact: true }).fill("context-reader");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { level: 4, name: room.title, exact: true }).click();
  const article = page.locator(`[data-message-id="${answer.id}"]`);
  await article.getByText("本文で引用: S1", { exact: true }).waitFor();
  assert.equal(await article.getByRole("button", { name: "参照元 S999 を開く", exact: true }).count(), 0);
  assert.equal(await article.locator("img").count(), 0);
  assert.ok((await article.textContent())!.includes("[[MAP_SOURCE:S999]]"));
  await article.getByRole("button", { name: "参照元 S1 を開く", exact: true }).first().click();
  const source = article.getByLabel("参照元 S1 の原文");
  await source.waitFor();
  assert.ok((await source.textContent())!.includes(original.content.replaceAll("\r\n", "\n")) || (await source.textContent())!.includes(original.content));
  assert.ok((await source.textContent())!.includes("2026/11/9") || (await source.textContent())!.includes("11/9/2026"));
  await page.reload();
  await page.getByRole("button", { name: "Logout", exact: true }).waitFor();
  await article.getByText("本文で引用: S1", { exact: true }).waitFor();
  assert.equal(await source.count(), 0, "reload drops open source text, receipt sidecar is reloaded");

  // A response for the previous Room cannot recreate an open excerpt after the Room changes.
  let release!: () => void;
  let intercepted!: () => void;
  let finished!: () => void;
  const held = new Promise<void>(ok => { release = ok; });
  const arrived = new Promise<void>(ok => { intercepted = ok; });
  const completed = new Promise<void>(ok => { finished = ok; });
  await page.route("**/rooms/*/search/citation", async route => {
    const response = await route.fetch();
    intercepted();
    await held;
    try { await route.fulfill({ response }); } catch { /* The Room switch aborts its original request. */ }
    finished();
  }, { times: 1 });
  await article.getByRole("button", { name: "参照元 S1 を開く", exact: true }).first().click();
  await arrived;
  await page.getByRole("heading", { level: 4, name: other.title, exact: true }).click();
  release();
  await completed;
  assert.equal(await page.getByLabel("参照元 S1 の原文").count(), 0);
  await page.getByRole("heading", { level: 4, name: room.title, exact: true }).click();
  await article.getByText("本文で引用: S1", { exact: true }).waitFor();

  // Pending requests retain mode, timezone and request ID even when acceptance is uncertain.
  const bodies: unknown[] = [];
  await page.route("**/rooms/*/turns", async route => {
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 1) await route.abort("failed"); else await route.continue();
  });
  await page.getByLabel("Context mode", { exact: true }).selectOption("none");
  await page.getByLabel("Recipient", { exact: true }).selectOption("all");
  await page.getByLabel("Message", { exact: true }).fill("A normal answer without retrieval.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("button", { name: "Recover acceptance with the same request" }).waitFor();
  assert.equal(await page.getByLabel("Context mode", { exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "Recover acceptance with the same request" }).click();
  await page.waitForFunction(() => !document.body.textContent!.includes("Recover acceptance with the same request"));
  assert.deepEqual(bodies[0], bodies[1]);
  assert.deepEqual((bodies[1] as any).context, { mode: "none", timeZone: "Asia/Tokyo" });
  await page.getByRole("heading", { level: 4, name: other.title, exact: true }).click();
  assert.equal(await page.getByLabel("Context mode", { exact: true }).inputValue(), "");
  assert.equal(await page.getByLabel("回答の参照資料").count(), 0);

  // BFCache and cross-tab session invalidation erase short-lived context selections.
  await page.getByLabel("Context mode", { exact: true }).selectOption("both");
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await page.getByRole("button", { name: "Logout", exact: true }).waitFor();
  assert.equal(await page.getByLabel("Context mode", { exact: true }).inputValue(), "");
  const second = await context.newPage();
  await second.goto(origin);
  await second.getByRole("button", { name: "Logout", exact: true }).click();
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  assert.equal(await page.getByLabel("回答の参照資料").count(), 0);
  assert.deepEqual(await page.evaluate(async () => ({ local: localStorage.length, session: sessionStorage.length,
    databases: await indexedDB.databases(), caches: await caches.keys(), workers: (await navigator.serviceWorker.getRegistrations()).length })),
    { local: 0, session: 0, databases: [], caches: [], workers: 0 });
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ suite: "context-browser", passed: true, syntheticProviderCalls: provider.calls.length, realProviderCalls: 0 }));
} finally {
  await browser?.close();
  await generation.shutdown();
  await new Promise<void>(ok => server.listening ? server.close(() => ok()) : ok());
  app.close();
  rmSync(root, { recursive: true, force: true });
}
