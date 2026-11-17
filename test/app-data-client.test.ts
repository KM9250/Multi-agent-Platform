import test from "node:test";
import assert from "node:assert/strict";
import {
  appRequest,
  AppAPIError,
  authorizedAttachmentURL,
  setSessionToken,
} from "../services/appClient.ts";

test("browser transport binds credentials/CSRF, never retries uncertain mutation, clears authority", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; options: RequestInit }[] = [];
  try {
    globalThis.fetch = (async (url, options) => {
      calls.push({ url: String(url), options: options! });
      throw new TypeError("network lost");
    }) as typeof fetch;
    setSessionToken({
      actorId: "actor",
      workspaceId: "workspace",
      csrfToken: "csrf-test",
      models: [],
    });
    await assert.rejects(
      appRequest("/rooms/r/turns", "POST", {
        requestId: "same-request",
        content: "synthetic",
      }),
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/api/app/v1/rooms/r/turns");
    assert.equal(calls[0].options.credentials, "same-origin");
    assert.equal(calls[0].options.cache, "no-store");
    assert.equal(calls[0].options.redirect, "error");
    assert.equal(
      (calls[0].options.headers as Record<string, string>)["X-CSRF-Token"],
      "csrf-test",
    );
    setSessionToken();
    await assert.rejects(appRequest("/session/logout", "POST", {}));
    assert.equal(
      (calls[1].options.headers as Record<string, string>)["X-CSRF-Token"],
      undefined,
    );
  } finally {
    globalThis.fetch = originalFetch;
    setSessionToken();
  }
});

test("browser errors never surface raw provider/server payloads", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: { code: "raw secret response" },
          prompt: "private prompt",
        }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
    await assert.rejects(
      appRequest("/session"),
      (error) =>
        error instanceof AppAPIError &&
        error.message === "REQUEST_FAILED" &&
        !JSON.stringify(error).includes("private"),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("attachment rendering constructs same-origin URL from IDs and ignores supplied destinations", () => {
  const url = authorizedAttachmentURL("room", {
    id: "attachment",
    url: "https://attacker.invalid/collect",
  });
  assert.equal(url, "/api/app/v1/rooms/room/attachments/attachment/content");
  assert.equal(
    new URL(
      authorizedAttachmentURL("r/x", { id: "../../escape" }),
      "https://app.invalid",
    ).origin,
    "https://app.invalid",
  );
});
