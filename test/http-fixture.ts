import { shutdownIndexWorkers } from "../server/search/index.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../server/app-data/db.ts";
import { ConversationRepository } from "../server/app-data/repository.ts";
import { AttachmentStore } from "../server/attachments/store.ts";
import { SessionService } from "../server/auth/sessions.ts";
import { AuthorizationPolicy } from "../server/auth/authorization.ts";
import { createAppHandler } from "../server/http/server.ts";
import { GenerationCoordinator } from "../server/generation/coordinator.ts";
import { FakeProvider } from "../server/generation/provider.ts";

export async function httpFixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), "map-http-")),
    app = new AppDatabase({ root }),
    sessions = new SessionService(app),
    policy = new AuthorizationPolicy(app);
  const actor = await sessions.createAccount({
    username: "synthetic-user",
    password: "synthetic-long-password",
  });
  const repository = new ConversationRepository(app, policy),
    attachments = new AttachmentStore(app, policy),
    provider = new FakeProvider();
  const generation = new GenerationCoordinator(app, repository, policy, {
    provider,
    defaultModel: "synthetic",
    attachmentStore: attachments,
  });
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
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
      allowedModels: ["synthetic"],
    }),
  );
  t.after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await shutdownIndexWorkers(app);
    app.close();
    rmSync(root, { recursive: true, force: true });
  });
  let cookie = "",
    csrf = "";
  const request = async (
    path: string,
    method = "GET",
    input?: any,
    extra: Record<string, string> = {},
  ) => {
    const response = await fetch(origin + "/api/app/v1" + path, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(method !== "GET"
          ? { "content-type": "application/json", origin, "x-csrf-token": csrf }
          : {}),
        ...extra,
      },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    const text = await response.text();
    return { response, data: text ? JSON.parse(text) : undefined };
  };
  const login = async () => {
    const result = await request("/session/login", "POST", {
      username: "synthetic-user",
      password: "synthetic-long-password",
    });
    assert.equal(result.response.status, 200);
    cookie = result.response.headers.get("set-cookie")!.split(";")[0];
    csrf = result.data.csrfToken;
    return result;
  };
  return {
    app,
    actor,
    policy,
    repository,
    provider,
    generation,
    origin,
    request,
    login,
    get cookie() {
      return cookie;
    },
    get csrf() {
      return csrf;
    },
  };
}
