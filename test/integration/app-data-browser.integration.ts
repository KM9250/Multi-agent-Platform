/** Synthetic provider only. Real Chrome, HTTP cookies, API, filesystem and SQLite. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { AppDatabase } from "../../server/app-data/db.ts";
import { ConversationRepository } from "../../server/app-data/repository.ts";
import { AttachmentStore } from "../../server/attachments/store.ts";
import { AuthorizationPolicy } from "../../server/auth/authorization.ts";
import { SessionService } from "../../server/auth/sessions.ts";
import { GenerationCoordinator } from "../../server/generation/coordinator.ts";
import { FakeProvider } from "../../server/generation/provider.ts";
import { ImportService } from "../../server/operations/import.ts";
import { ExportService } from "../../server/operations/export.ts";
import { createAppHandler } from "../../server/http/server.ts";

const root = mkdtempSync(join(tmpdir(), "map-data-browser-"));
const app = new AppDatabase({ root }),
  policy = new AuthorizationPolicy(app),
  sessions = new SessionService(app);
const repository = new ConversationRepository(app, policy),
  attachments = new AttachmentStore(app, policy);
const provider = new FakeProvider(),
  generation = new GenerationCoordinator(app, repository, policy, {
    provider,
    defaultModel: "synthetic",
    attachmentStore: attachments,
  });
const imports = new ImportService(app, repository, attachments, policy),
  exports = new ExportService(app, repository, attachments, policy);
const password = "synthetic-browser-password-2026";
const server = createServer();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const external: string[] = [];
const consoleErrors: string[] = [];
const http: Record<string, number> = {};
async function login(page: Page, origin: string) {
  await page.goto(origin);
  await page
    .getByRole("textbox", { name: "Username", exact: true })
    .fill("browser-user");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Logout", exact: true }).waitFor();
}
async function waitText(page: Page, text: string) {
  await page
    .getByText(text, { exact: true })
    .first()
    .waitFor({ timeout: 15000 });
}
async function monitor(context: BrowserContext, origin: string) {
  context.on("request", (request) => {
    if (
      !request.url().startsWith(origin) &&
      !request.url().startsWith("data:") &&
      !request.url().startsWith("blob:")
    )
      external.push(request.url());
  });
  context.on("page", (page) =>
    page.on("pageerror", (error) => consoleErrors.push(error.message)),
  );
}
try {
  const account = await sessions.createAccount({
    username: "browser-user",
    password,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
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
      imports,
      exports,
      origin,
      development: true,
      staticRoot: resolve("dist"),
      allowedModels: ["synthetic"],
      onRequest: (r) => {
        http[`${r.method} ${r.status}`] =
          (http[`${r.method} ${r.status}`] ?? 0) + 1;
      },
    }),
  );
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext();
  await monitor(context, origin);
  const page = await context.newPage();
  await login(page, origin);
  assert.equal(
    (await context.cookies()).find((c) => c.name === "map_session")?.httpOnly,
    true,
  );
  await page.getByRole("button", { name: "New Chat", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Room Name", exact: true })
    .fill("Browser persistence room");
  await page.getByRole("button", { name: "Create Room", exact: true }).click();
  await page
    .getByRole("heading", { name: "Browser persistence room", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page
    .getByRole("button", { name: "Add Agent to Room", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Persona Name", exact: true })
    .fill("Browser Persona");
  await page
    .getByRole("combobox", { name: "Model", exact: true })
    .selectOption("synthetic");
  await page.getByRole("button", { name: "Upload Image", exact: true }).click();
  const avatarBase64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 8;
    canvas.height = 8;
    canvas.getContext("2d")!.fillRect(0, 0, 8, 8);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page
    .locator('input[type=file][accept="image/png,image/jpeg,image/webp"]')
    .setInputFiles({
      name: "synthetic-avatar.png",
      mimeType: "image/png",
      buffer: Buffer.from(avatarBase64, "base64"),
    });
  await page.getByRole("img", { name: "Avatar", exact: true }).waitFor();
  await page
    .locator('input[type=file][accept=".md,.markdown,.txt"]')
    .setInputFiles({
      name: "synthetic-context.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Synthetic approved context text"),
    });
  await page.getByText("1. synthetic-context.txt", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await page
    .getByRole("heading", { name: "Create New Agent" })
    .waitFor({ state: "hidden" });
  await page
    .getByRole("combobox", { name: "Recipient", exact: true })
    .selectOption("all");
  const malicious =
    '<img src="https://attacker.invalid/collect" onerror="window.PWNED=true"> [link](javascript:alert(1))';
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill(malicious);
  await page.locator("input[type=file][multiple]").setInputFiles({
    name: "synthetic-note.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Synthetic attachment text"),
  });
  let lostAcceptance = false;
  await page.route("**/api/app/v1/rooms/*/turns", async (route) => {
    if (!lostAcceptance) {
      lostAcceptance = true;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page
    .getByRole("button", { name: "Recover acceptance with the same request" })
    .waitFor();
  await page
    .getByRole("button", { name: "Recover acceptance with the same request" })
    .click();
  await waitText(page, "Synthetic server response.");
  assert.equal(provider.calls.length, 1);
  assert.ok(
    JSON.stringify(provider.calls[0]).includes(
      "Synthetic approved context text",
    ),
  );
  assert.equal(
    await page.evaluate(() => Boolean((window as any).PWNED)),
    false,
  );
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: /synthetic-note.txt/ }).click();
  const download = await downloadPromise;
  assert.equal(download.failure() instanceof Promise, true);
  assert.equal(await download.failure(), null);
  await page.reload();
  await waitText(page, "Synthetic server response.");
  assert.equal(provider.calls.length, 1);
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.waitForFunction(() =>
    [...document.images].some(
      (image) =>
        image.alt === "Browser Persona" &&
        image.complete &&
        image.naturalWidth > 0,
    ),
  );
  await page.getByRole("button", { name: "Edit Agent", exact: true }).click();
  const contextDownload = page.waitForEvent("download");
  await page
    .getByRole("link", { name: "synthetic-context.txt", exact: true })
    .click();
  assert.equal(await (await contextDownload).failure(), null);
  await page.getByRole("button", { name: "Close Persona editor" }).click();
  const firstArticle = page
    .locator("article")
    .filter({ has: page.getByText(malicious, { exact: true }) });
  await firstArticle
    .getByRole("button", { name: "Correct", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Corrected message" })
    .fill("Corrected browser message");
  await page
    .getByRole("button", { name: "Save correction", exact: true })
    .click();
  await waitText(page, "Corrected browser message");
  const corrected = page.locator("article").filter({
    has: page.getByText("Corrected browser message", { exact: true }),
  });
  await corrected
    .getByRole("button", { name: "Revision history", exact: true })
    .click();
  await page.getByRole("dialog", { name: "Revision history" }).waitFor();
  assert.ok(
    (
      await page.getByRole("dialog", { name: "Revision history" }).innerText()
    ).includes("attacker.invalid"),
  );
  await page.getByRole("button", { name: "Close Revision history" }).click();
  await page.getByRole("button", { name: "Regenerate", exact: true }).click();
  await page
    .waitForFunction(() =>
      [...document.querySelectorAll("article")].some(
        (node) =>
          node.textContent?.includes("revision 2") &&
          node.textContent.includes("Synthetic server response."),
      ),
    )
    .catch(async (error) => {
      console.error(await page.locator("body").innerText());
      throw error;
    });
  assert.equal(provider.calls.length, 2);
  const fresh = await browser.newContext();
  await monitor(fresh, origin);
  const freshPage = await fresh.newPage();
  await login(freshPage, origin);
  await waitText(freshPage, "Corrected browser message");
  assert.equal(provider.calls.length, 2);
  await freshPage.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await freshPage.reload();
  await waitText(freshPage, "Corrected browser message");
  assert.equal(provider.calls.length, 2);
  // An open editor must retain its initial revision even while background polling sees a concurrent update.
  await page
    .getByRole("button", { name: "Room settings", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Room Name", exact: true })
    .fill("Unsaved conflict title");
  const freshSession = await (
    await freshPage.request.get(`${origin}/api/app/v1/session`)
  ).json();
  const roomList = await (
    await freshPage.request.get(`${origin}/api/app/v1/rooms`)
  ).json();
  const currentRoom = roomList.find(
    (r: any) => r.title === "Browser persistence room",
  );
  const changed = await freshPage.request.patch(
    `${origin}/api/app/v1/rooms/${currentRoom.id}`,
    {
      headers: { Origin: origin, "X-CSRF-Token": freshSession.csrfToken },
      data: {
        expectedRevision: currentRoom.revision,
        description: "Concurrent browser change",
      },
    },
  );
  assert.equal(changed.status(), 200);
  await page.waitForFunction(() =>
    document.querySelector("header")?.textContent?.includes("revision 2"),
  );
  assert.equal(
    await page
      .getByRole("textbox", { name: "Room Name", exact: true })
      .inputValue(),
    "Unsaved conflict title",
  );
  const conflictResponse = page.waitForResponse(
    (r) =>
      r.request().method() === "PATCH" &&
      r.url().endsWith(`/rooms/${currentRoom.id}`),
  );
  await page.getByRole("button", { name: "Save Changes", exact: true }).click();
  assert.equal((await conflictResponse).status(), 409);
  await page.getByRole("button", { name: "Close room editor" }).click();
  await freshPage.getByRole("button", { name: "Logout", exact: true }).click();
  await freshPage
    .getByRole("heading", { name: "Sign in", exact: true })
    .waitFor();
  assert.equal(
    (await freshPage.request.get(`${origin}/api/app/v1/rooms`)).status(),
    401,
  );
  const mainSession = await (
    await page.request.get(`${origin}/api/app/v1/session`)
  ).json();
  const roomRoute = `**/api/app/v1/rooms/${currentRoom.id}`;
  await page.route(roomRoute, (route) =>
    route.request().method() === "GET"
      ? route.abort("failed")
      : route.continue(),
  );
  const separated = await page.request.patch(
    `${origin}/api/app/v1/rooms/${currentRoom.id}`,
    {
      headers: { Origin: origin, "X-CSRF-Token": mainSession.csrfToken },
      data: { expectedRevision: 2, internalStateSettings: { enabled: true } },
    },
  );
  assert.equal(separated.status(), 200);
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("/memory");
  const staleSend = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/turns"),
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  assert.equal((await staleSend).status(), 409);
  await page
    .getByText(
      "Request rejected before acceptance. Your draft is retained; review the current settings and send explicitly.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .inputValue(),
    "/memory",
  );
  assert.equal(provider.calls.length, 2);
  await page.unroute(roomRoute);
  await page.waitForFunction(() =>
    document.querySelector("header")?.textContent?.includes("revision 3"),
  );
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("draft remains editable");
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("/memory");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page
    .locator("main details summary")
    .filter({ hasText: "(3) · Result saved" })
    .waitFor();
  assert.equal(provider.calls.length, 3);
  assert.equal(
    await page
      .getByText("Synthetic memory; Vault unpublished.", { exact: true })
      .count(),
    0,
  );
  await page.locator("main details summary").click();
  await page
    .getByRole("button", {
      name: "Read authorized internal result",
      exact: true,
    })
    .first()
    .click();
  const internalReader = page.getByRole("dialog", {
    name: "Authorized internal result",
  });
  await internalReader.waitFor();
  assert.ok(
    !(await internalReader.innerText()).includes(
      "Synthetic memory; Vault unpublished.",
    ),
  );
  await page
    .getByRole("button", { name: "Close Authorized internal result" })
    .click();
  const persona = repository.getRoom(account, currentRoom.id).agents[0];
  policy.grant(account.actorId, account.workspaceId, "READ_PRIVATE_SEGMENT", {
    roomId: currentRoom.id,
    personaId: persona.id,
    visibility: "self_only",
  });
  await page
    .getByRole("button", {
      name: "Read authorized internal result",
      exact: true,
    })
    .first()
    .click();
  await internalReader.waitFor();
  assert.ok(
    (await internalReader.innerText()).includes(
      "Synthetic memory; Vault unpublished.",
    ),
  );
  await page
    .getByRole("button", { name: "Close Authorized internal result" })
    .click();
  // The legacy source is fixture data. Reading it is only triggered by the explicit export button.
  const legacy = {
    id: "legacy-room",
    title: "Imported browser room",
    description: "fixture",
    type: "Sandbox",
    agents: [
      {
        id: "legacy-pin-persona",
        name: "Imported pin persona",
        model: "synthetic",
        historyWindow: 1,
        pinFirstMessage: true,
      },
    ],
    messages: [
      {
        id: "legacy-message",
        role: "user",
        content: "Legacy original text",
        timestamp: 1700000000000,
        isStreaming: true,
      },
    ],
    updatedAt: 1700000000000,
  };
  await page.evaluate(
    (room) => localStorage.setItem("rooms", JSON.stringify([room])),
    legacy,
  );
  await page.getByRole("button", { name: "Migration", exact: true }).click();
  const exportDownload = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export this browser’s legacy rooms" })
    .click();
  await exportDownload;
  await page.getByRole("button", { name: "Dry run", exact: true }).click();
  await page
    .getByRole("button", { name: "Confirm import", exact: true })
    .waitFor({ state: "visible" });
  await page
    .getByRole("button", { name: "Confirm import", exact: true })
    .click();
  await page
    .getByText(
      "Import reconciled. Reopen the rooms to verify the saved content.",
      { exact: true },
    )
    .waitFor({ timeout: 15000 });
  assert.equal(provider.calls.length, 3);
  assert.ok(await page.evaluate(() => localStorage.getItem("rooms")));
  await page.getByRole("button", { name: "Close Legacy migration" }).click();
  await page.getByRole("button", { name: "Chats", exact: true }).click();
  await page
    .getByRole("heading", { name: "Imported browser room", exact: true })
    .click();
  await waitText(page, "Legacy original text");
  // Imported settings stay readable; a later input must fail visibly without losing its attachment.
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Pinned conflict input");
  await page.locator("input[type=file][multiple]").setInputFiles({
    name: "pin-input.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Retained pinned input attachment"),
  });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const guidance = "履歴を2件以上にするか、最初の発言固定を解除してください。";
  await page.locator("summary").filter({ hasText: guidance }).waitFor();
  await waitText(page, "Pinned conflict input");
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Editable after rejection");
  assert.equal(
    await page.getByRole("button", { name: "Send", exact: true }).isEnabled(),
    true,
  );
  assert.equal(provider.calls.length, 3);
  const rejected = app.db
    .prepare(
      "SELECT run_id,state FROM app_generation_runs WHERE error_code='HISTORY_WINDOW_PIN_CONFLICT'",
    )
    .all();
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].state, "FAILED");
  assert.equal(
    app.db
      .prepare("SELECT count(*) n FROM app_provider_calls WHERE run_id=?")
      .get(rejected[0].run_id)!.n,
    0,
  );
  await page.reload();
  await page.locator("summary").filter({ hasText: guidance }).waitFor();
  await waitText(page, "Pinned conflict input");
  await page.getByRole("link", { name: /pin-input.txt/ }).waitFor();
  assert.equal(provider.calls.length, 3);
  sessions.revokeAccount(account.actorId);
  await page
    .getByRole("heading", { name: "Sign in", exact: true })
    .waitFor({ timeout: 10000 });
  assert.equal(
    await page.getByText("Legacy original text", { exact: true }).count(),
    0,
  );
  assert.equal(http["GET 500"] ?? 0, 0);
  assert.equal(
    external.length,
    0,
    `Unexpected external requests: ${external.join(",")}`,
  );
  assert.deepEqual(consoleErrors, []);
  console.log(
    JSON.stringify({
      suite: "app-data-browser",
      provider: "synthetic",
      checks: [
        "real login cookie",
        "UI room/persona",
        "upload/download",
        "avatar/context restore",
        "persisted turn",
        "lost acceptance ACK recovery",
        "reload",
        "fresh browser",
        "storage clear",
        "correction/history",
        "explicit regeneration",
        "stale editor conflict",
        "rejected send retains editable draft",
        "logout rejection",
        "session revocation clears cache",
        "memory explicit authorized reader",
        "migration dry-run/import",
        "window-one pin conflict guidance and retained input/attachment after reload",
        "literal HTML/no external requests",
      ],
      providerCalls: provider.calls.length,
      http,
      externalRequests: external.length,
      passed: true,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      providerCalls: provider.calls.length,
      observedAt: Date.now(),
      http,
      consoleErrors,
      pages: await Promise.all(
        (browser?.contexts().flatMap((context) => context.pages()) ?? []).map(
          async (page) => ({
            path: new URL(page.url()).pathname,
            body: await page
              .locator("body")
              .innerText({ timeout: 2000 })
              .catch(() => "unavailable"),
          }),
        ),
      ),
      runs: app.db
        .prepare(
          "SELECT run_id,state,error_code,accepted_at,dispatch_before,deadline_at,completed_at FROM app_generation_runs",
        )
        .all(),
    }),
  );
  throw error;
} finally {
  await browser?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  app.close();
  rmSync(root, { recursive: true, force: true });
}
