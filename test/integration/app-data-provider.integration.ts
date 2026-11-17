/** Explicitly billable, synthetic-data-only smoke test. Never imported by npm test. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { randomUUID } from "node:crypto";
import { AppDatabase } from "../../server/app-data/db";
import { ConversationRepository } from "../../server/app-data/repository";
import { AttachmentStore } from "../../server/attachments/store";
import { SessionService } from "../../server/auth/sessions";
import { AuthorizationPolicy } from "../../server/auth/authorization";
import { GenerationCoordinator } from "../../server/generation/coordinator";
import { GeminiProvider } from "../../server/generation/provider";
import { createAppHandler } from "../../server/http/server";

const env = process.env;
function positive(name: string, max: number) {
  const n = Number(env[name]);
  if (!Number.isSafeInteger(n) || n <= 0 || n > max)
    throw new Error(`${name}_REQUIRED`);
  return n;
}
if (
  env.MAP_LIVE_PROVIDER_ENABLE !== "synthetic-only-billable-test" ||
  !env.GEMINI_API_KEY ||
  !env.MAP_LIVE_MODEL
)
  throw new Error("LIVE_PROVIDER_EXPLICIT_ENABLE_KEY_MODEL_REQUIRED");
const maxCalls = positive("MAP_LIVE_MAX_CALLS", 1),
  maxCostMicros = positive("MAP_LIVE_MAX_COST_MICROS", 1_000_000);
const inputRate = positive("MAP_LIVE_INPUT_MICROS_PER_MILLION", 1_000_000_000),
  outputRate = positive("MAP_LIVE_OUTPUT_MICROS_PER_MILLION", 1_000_000_000);
if (!env.MAP_LIVE_PRICING_VERSION)
  throw new Error("LIVE_PROVIDER_PRICING_VERSION_REQUIRED");
const root = mkdtempSync(join(tmpdir(), "map-live-synthetic-"));
let app: AppDatabase | undefined;
let generation: GenerationCoordinator | undefined;
let server: ReturnType<typeof createServer> | undefined;
let providerHttpCalls = 0;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
if (!existsSync(resolve("dist/index.html")))
  throw new Error("LIVE_BROWSER_BUILD_REQUIRED");
try {
  browser = await chromium.launch({
    executablePath: env.CHROMIUM_PATH ?? "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  app = new AppDatabase({ root });
  const sessions = new SessionService(app),
    policy = new AuthorizationPolicy(app),
    repository = new ConversationRepository(app, policy),
    attachments = new AttachmentStore(app, policy);
  const password = randomUUID() + randomUUID();
  await sessions.createAccount({ username: "synthetic-live-test", password });
  const provider = new GeminiProvider({
    apiKey: env.GEMINI_API_KEY,
    allowedModels: [env.MAP_LIVE_MODEL],
    fetch: async (input, init) => {
      if (++providerHttpCalls > maxCalls) throw new Error("LIVE_CALL_LIMIT");
      return fetch(input, init);
    },
  });
  generation = new GenerationCoordinator(app, repository, policy, {
    provider,
    defaultModel: env.MAP_LIVE_MODEL,
    attachmentStore: attachments,
    limits: {
      maxCalls,
      maxCostMicros,
      maxOutputTokens: 128,
      maxInputTokens: 4096,
      maxTotalTokens: 8192,
      maxPersonas: 1,
    },
    pricing: {
      version: env.MAP_LIVE_PRICING_VERSION,
      inputMicrosPerMillion: inputRate,
      outputMicrosPerMillion: outputRate,
    },
  });
  server = createServer();
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
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
      allowedModels: [env.MAP_LIVE_MODEL],
    }),
  );
  let cookie = "",
    csrf = "";
  const request = async (path: string, method = "GET", input?: unknown) => {
    const response = await fetch(origin + "/api/app/v1" + path, {
      method,
      headers: {
        cookie,
        ...(method === "GET"
          ? {}
          : {
              "content-type": "application/json",
              origin,
              "x-csrf-token": csrf,
            }),
      },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    const result = await response.json();
    assert.ok(response.ok, `HTTP_${response.status}`);
    return { response, result };
  };
  async function login() {
    const { response, result } = await request("/session/login", "POST", {
      username: "synthetic-live-test",
      password,
    });
    cookie = response.headers.get("set-cookie")!.split(";")[0];
    csrf = result.csrfToken;
  }
  await login();
  const room = (
    await request("/rooms", "POST", {
      title: "Synthetic live adapter smoke test",
    })
  ).result;
  await request(`/rooms/${room.id}/personas`, "POST", {
    name: "Synthetic verification persona",
    model: env.MAP_LIVE_MODEL,
    systemInstruction:
      "This is synthetic integration test data. Return exactly the text SYNTHETIC_OK.",
  });
  const browserContext = await browser.newContext();
  const page = await browserContext.newPage();
  await page.goto(origin);
  await page
    .getByRole("textbox", { name: "Username", exact: true })
    .fill("synthetic-live-test");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Logout", exact: true }).waitFor();
  const accepted = (
    await request(`/rooms/${room.id}/turns`, "POST", {
      requestId: randomUUID(),
      expectedRoomRevision: room.revision,
      content: "Synthetic test only. Please reply SYNTHETIC_OK.",
      recipient: { type: "all" },
    })
  ).result;
  let receipt: any;
  const deadline = Date.now() + 130000;
  do {
    receipt = (await request(`/rooms/${room.id}/generations/${accepted.runId}`))
      .result;
    if (!["QUEUED", "RUNNING"].includes(receipt.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  assert.equal(receipt.status, "COMPLETED");
  assert.equal(providerHttpCalls, 1);
  assert.equal(receipt.usage[0].completeness, "COMPLETE");
  assert.equal(receipt.results.length, 1);
  const before = (await request(`/rooms/${room.id}/messages`)).result;
  await request("/session/logout", "POST", {});
  cookie = "";
  csrf = "";
  await login();
  const after = (await request(`/rooms/${room.id}/messages`)).result;
  assert.deepEqual(after, before);
  assert.equal(providerHttpCalls, 1);
  const answer = receipt.results[0].content;
  assert.ok(typeof answer === "string" && answer.length > 0);
  await page.reload();
  await page
    .getByText(answer, { exact: true })
    .first()
    .waitFor({ timeout: 15000 });
  await page.reload();
  await page
    .getByText(answer, { exact: true })
    .first()
    .waitFor({ timeout: 15000 });
  assert.equal(providerHttpCalls, 1);
  console.log(
    JSON.stringify({
      mode: "LIVE_PROVIDER_SYNTHETIC_INPUT",
      model: env.MAP_LIVE_MODEL,
      providerHttpCalls,
      status: receipt.status,
      usage: receipt.usage.map((u: any) => ({
        completeness: u.completeness,
        usage: u.usage,
        actualCostMicros: u.actualCostMicros,
        pricingVersion: u.pricingVersion,
      })),
      persistedAcrossSession: true,
      browserReload: "PASSED",
    }),
  );
} finally {
  await browser?.close();
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  await generation?.shutdown();
  app?.close();
  rmSync(root, { recursive: true, force: true });
}
