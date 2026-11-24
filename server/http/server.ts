import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import type { AppDatabase } from "../app-data/db.ts";
import {
  AuthError,
  type AuthorizationPolicy,
  type Actor,
} from "../auth/authorization.ts";
import type { SessionService } from "../auth/sessions.ts";

import { searchRoom } from "../search/service.ts";
import { searchInput, citationInput } from "../search/input.ts";
import { SearchSources } from "../search/sources.ts";
import { memoryRoutes } from "./memory.ts";
import { assertVaultOutsideStatic } from "../memory/vault.ts";

export interface AppServerOptions {
  app: AppDatabase;
  sessions: SessionService;
  policy: AuthorizationPolicy;
  repository: any;
  attachments: any;
  generation?: any;
  imports?: any;
  exports?: any;
  origin: string;
  development: boolean;
  staticRoot?: string;
  allowedModels?: string[];
  /** A loopback reverse proxy must strip untrusted forwarding headers. */
  trustedProxy?: boolean;
  onRequest?: (entry: {
    method: string;
    route: string;
    status: number;
    elapsedMs: number;
  }) => void;
}
const PREFIX = "/api/app/v1";
const COOKIE = "map_session";
const MUTATIONS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SAFE_ERRORS = new Set([
  "FORBIDDEN",
  "UNAUTHENTICATED",
  "CSRF_REJECTED",
  "LOGIN_FAILED",
  "LOGIN_RATE_LIMIT",
  "AUTH_BUSY",
  "INVALID_INPUT",
  "HISTORICAL_PERSONA_IMMUTABLE",
  "EXPORT_SOURCE_LIMIT",
  "INVALID_USERNAME",
  "PASSWORD_LENGTH",
  "NOT_FOUND",
  "REVISION_CONFLICT",
  "REQUEST_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "CONFLICT",
  "CONTEXT_LIMIT",
  "BUDGET_EXCEEDED",
  "PROVIDER_NOT_CONFIGURED",
  "LIMIT_EXCEEDED",
  "TOO_LARGE",
  "INVALID_CURSOR",
  "CURSOR_EXPIRED",
  "MEMORY_INTEGRITY",
  "MEMORY_UNAVAILABLE",
  "MEMORY_RESYNC_REQUIRED",
  "SEARCH_RESYNC_REQUIRED",
  "INVALID_CITATION_RANGE",
  "VAULT_UNREGISTERED",
  "VAULT_IDENTITY_CHANGED",
  "VAULT_ADAPTER_UNAVAILABLE",
  "INVALID_MEMORY_MARKDOWN",
  "PUBLICATION_CONFLICT",
  "ATTACHMENT_MISSING",
  "ATTACHMENT_INTEGRITY",
  "INTEGRITY_ERROR",
  "IMPORT_CONFLICT",
  "IMPORT_INVALID",
  "IMPORT_INCOMPLETE",
  "MAINTENANCE",
  "STORAGE_FAILURE",
]);
for (const code of [
  "UNKNOWN_FIELD",
  "INPUT_TOO_LARGE",
  "INPUT_TOO_DEEP",
  "TRANSACTION_ABORTED",
  "ATTACHMENT_TOO_LARGE",
  "ATTACHMENT_NOT_AVAILABLE",
  "ATTACHMENT_LIMIT",
  "MIME_MISMATCH",
  "UNSUPPORTED_MEDIA_TYPE",
  "NO_ACTIVE_PERSONA",
  "MODEL_NOT_ALLOWED",
  "QUEUE_FULL",
  "PERSONA_LIMIT",
  "IMPORT_SOURCE_CONFLICT",
  "IMPORT_RECONCILIATION_FAILED",
  "IMPORT_DIGEST_MISMATCH",
  "EXPORT_REVISION_LIMIT",
  "EXPORT_DIAGNOSTIC_LIMIT",
  "EXPORT_CHUNK_LIMIT",
  "EXPORT_AUTHORIZATION_CHANGED",
  "EXPORT_SOURCE_CHANGED",
  "USE_REGENERATION",
  "CONTEXT_TOO_LARGE",
  "BUDGET_LIMIT",
  "AUTHORIZATION_CHANGED",
  "SOURCE_CHANGED",
  "PROVIDER_UNAVAILABLE",
  "INVALID_RECIPIENT",
  "GENERATION_NOT_FOUND",
  "RUN_NOT_FOUND",
  "RUN_NOT_CANCELLABLE",
  "DEADLINE_EXCEEDED",
])
  SAFE_ERRORS.add(code);
for (const code of [
  "ACTUAL_BUDGET_EXCEEDED",
  "AMBIGUOUS_CONTENT",
  "ATTACHMENT_CONFLICT",
  "ATTACHMENT_IN_PROGRESS",
  "ATTACHMENT_STORE_REQUIRED",
  "CALL_CONFLICT",
  "CANCELLED",
  "COLLECTION_EXPIRED",
  "CONFIGURATION_REVISION_CHANGED",
  "CONTEXT_ATTACHMENT_TYPE",
  "CONTEXT_CHANGED",
  "DISPATCH_EXPIRED",
  "IMPORT_ATTACHMENT_INVALID",
  "IMPORT_ATTACHMENT_LIMIT",
  "IMPORT_ATTACHMENT_TYPE",
  "IMPORT_DEPTH_LIMIT",
  "IMPORT_DUPLICATE_ID",
  "IMPORT_LIMIT",
  "IMPORT_REFERENCE_MISSING",
  "IMPORT_UNKNOWN_FIELD",
  "IMPORT_UNTRUSTED_FIELD",
  "INPUT_REVISION_CHANGED",
  "INVALID_ATTACHMENT",
  "INVALID_DECISION",
  "INVALID_OUTPUT",
  "INVALID_SEGMENTS",
  "ORIGINAL_INPUT_NOT_FOUND",
  "PERSONA_DISABLED",
  "PROVIDER_NOT_ALLOWED",
  "PROVIDER_OUTCOME_UNKNOWN",
  "RECIPIENT_NOT_FOUND",
  "RESULT_LIMIT",
  "SEND_NOT_AUTHORIZED",
  "SERVER_STOPPED",
  "SERVER_STOPPING",
  "SUBAGENT_LIMIT",
  "UNSAFE_PATH",
  "UPLOAD_REQUIRED",
  "USAGE_INCOMPLETE",
])
  SAFE_ERRORS.add(code);

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}
function closed(value: any, keys: string[], required: string[] = []): any {
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    required.some((key) => !(key in value))
  )
    throw new AuthError("INVALID_INPUT", 400);
  return value;
}
function boundedJson(value: any, depth = 0, budget = { nodes: 0 }): void {
  if (depth > 16 || ++budget.nodes > 100000)
    throw new AuthError("TOO_LARGE", 413);
  if (typeof value === "number" && !Number.isFinite(value))
    throw new AuthError("INVALID_INPUT", 400);
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value) && value.length > 10000)
    throw new AuthError("TOO_LARGE", 413);
  for (const key of Object.keys(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key))
      throw new AuthError("INVALID_INPUT", 400);
    boundedJson(value[key], depth + 1, budget);
  }
}
async function body(request: IncomingMessage, max = 1024 * 1024): Promise<any> {
  if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] ?? ""))
    throw new AuthError("INVALID_INPUT", 415);
  if (Number(request.headers["content-length"] ?? 0) > max)
    throw new AuthError("TOO_LARGE", 413);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > max) throw new AuthError("TOO_LARGE", 413);
    chunks.push(chunk);
  }
  let value: any;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AuthError("INVALID_INPUT", 400);
  }
  boundedJson(value);
  return value;
}
function cookieToken(request: IncomingMessage): string | undefined {
  const cookies = (request.headers.cookie ?? "")
    .split(";")
    .map((x) => x.trim())
    .filter((x) => x.startsWith(`${COOKIE}=`));
  if (cookies.length !== 1) return undefined;
  return cookies[0].slice(COOKIE.length + 1);
}
function setCookie(
  response: ServerResponse,
  token: string,
  secure: boolean,
  maxAge: number,
): void {
  response.setHeader(
    "Set-Cookie",
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`,
  );
}
function routeId(value: string): string {
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(value))
    throw new AuthError("NOT_FOUND", 404);
  return value;
}
function requireService<T>(service: T | undefined): T {
  if (!service) throw new AuthError("PROVIDER_NOT_CONFIGURED", 503);
  return service;
}

export function createAppHandler(options: AppServerOptions) {
  if (options.staticRoot)
    assertVaultOutsideStatic(options.app, options.staticRoot);
  const origin = new URL(options.origin);
  if (
    origin.origin !== options.origin ||
    origin.username ||
    origin.password ||
    (!options.development && origin.protocol !== "https:") ||
    (options.development &&
      (origin.protocol !== "http:" ||
        !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)))
  )
    throw new AuthError("INVALID_CONFIGURATION", 500);
  const {
    repository: repo,
    attachments,
    generation,
    imports,
    exports: exporter,
    sessions,
    policy,
  } = options;
  const handleMemory = memoryRoutes(options.app, policy);
  const memoryLimits = generation?.limits && {
    maxHistory: generation.limits.maxHistory,
    maxCalls: generation.limits.maxCalls,
    maxTotalTokens: generation.limits.maxTotalTokens,
  };
  const enqueue = (receipt: any) => {
    if (receipt.status === "QUEUED" && generation)
      setImmediate(() => {
        Promise.resolve(generation.execute(receipt.runId ?? receipt.id)).catch(
          () => {
            /* persisted coordinator state is the diagnostic source */
          },
        );
      });
    return receipt;
  };
  return async (request: IncomingMessage, response: ServerResponse) => {
    const start = performance.now(),
      method = request.method ?? "GET";
    let route = "invalid";
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    response.on("finish", () =>
      options.onRequest?.({
        method,
        route,
        status: response.statusCode,
        elapsedMs: performance.now() - start,
      }),
    );
    try {
      if (request.headers.host !== origin.host)
        throw new AuthError("FORBIDDEN", 403);
      if (options.trustedProxy) {
        if (
          !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
            request.socket.remoteAddress ?? "",
          ) ||
          request.headers["x-forwarded-proto"] !== "https"
        )
          throw new AuthError("FORBIDDEN", 403);
      } else if (
        request.headers["x-forwarded-host"] ||
        request.headers["x-forwarded-proto"]
      )
        throw new AuthError("FORBIDDEN", 403);
      if (request.headers.origin && request.headers.origin !== origin.origin)
        throw new AuthError("FORBIDDEN", 403);
      const url = new URL(request.url ?? "/", origin);
      if (url.origin !== origin.origin || /%2f|%5c/i.test(url.pathname))
        throw new AuthError("FORBIDDEN", 403);
      if (!url.pathname.startsWith(PREFIX + "/")) {
        route = "static";
        if (!options.staticRoot || !["GET", "HEAD"].includes(method))
          throw new AuthError("NOT_FOUND", 404);
        const pathname = decodeURIComponent(url.pathname),
          base = await realpath(options.staticRoot);
        const relative = pathname === "/" ? "index.html" : pathname.slice(1);
        if (
          relative.split("/").some((x) => x.startsWith(".")) ||
          relative.includes("\\")
        )
          throw new AuthError("NOT_FOUND", 404);
        let candidate: string;
        try {
          candidate = await realpath(resolve(base, relative));
        } catch (error: any) {
          if (error?.code === "ENOENT" || error?.code === "ENOTDIR")
            throw new AuthError("NOT_FOUND", 404);
          throw error;
        }
        if (
          !candidate.startsWith(base + sep) ||
          !(await stat(candidate)).isFile()
        )
          throw new AuthError("NOT_FOUND", 404);
        const mime: Record<string, string> = {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".svg": "image/svg+xml",
          ".png": "image/png",
          ".woff2": "font/woff2",
        };
        if (!mime[extname(candidate)] || extname(candidate) === ".map")
          throw new AuthError("NOT_FOUND", 404);
        response.writeHead(200, { "Content-Type": mime[extname(candidate)] });
        response.end(method === "HEAD" ? undefined : await readFile(candidate));
        return;
      }
      const parts = url.pathname
        .slice(PREFIX.length + 1)
        .split("/")
        .map(routeId);
      const memoryRoute =
        parts[0] === "memory" ||
        (parts[0] === "rooms" && parts[2] === "memory");
      route = memoryRoute
        ? "memory"
        : parts.map((x, i) => (i % 2 === 1 ? ":id" : x)).join("/");
      if (MUTATIONS.has(method) && request.headers.origin !== origin.origin)
        throw new AuthError("CSRF_REJECTED", 403);
      if (parts.join("/") === "session/login" && method === "POST") {
        const input = closed(
          await body(request, 4096),
          ["username", "password"],
          ["username", "password"],
        );
        const result = await sessions.login(
          input.username,
          input.password,
          request.socket.remoteAddress,
        );
        // Each successful login always issues a fresh opaque session, ignoring supplied cookies.
        setCookie(
          response,
          result.token,
          !options.development,
          Math.floor(sessions.absoluteTimeoutMs / 1000),
        );
        json(response, 200, {
          actorId: result.actor.actorId,
          workspaceId: result.actor.workspaceId,
          csrfToken: result.csrfToken,
          expiresAt: result.expiresAt,
          models: options.allowedModels ?? [],
          memoryLimits,
        });
        return;
      }
      const session = sessions.authenticate(cookieToken(request));
      const actor = session.actor;
      if (MUTATIONS.has(method))
        sessions.verifyCsrf(
          actor,
          typeof request.headers["x-csrf-token"] === "string"
            ? request.headers["x-csrf-token"]
            : undefined,
        );
      if (parts[0] === "session") {
        if (parts.length === 1 && method === "GET") {
          json(response, 200, {
            actorId: actor.actorId,
            workspaceId: actor.workspaceId,
            csrfToken: session.csrfToken,
            expiresAt: session.expiresAt,
            models: options.allowedModels ?? [],
            memoryLimits,
          });
          return;
        }
        if (parts[1] === "logout" && parts.length === 2 && method === "POST") {
          closed(await body(request, 1024), []);
          sessions.logout(actor);
          setCookie(response, "", !options.development, 0);
          json(response, 200, { loggedOut: true });
          return;
        }
      }
      if (parts[0] === "rooms" && parts[2] === "search") {
        route = "room_search";
        if (method !== "POST" || url.search || parts.length > 4)
          throw new AuthError("INVALID_INPUT", 400);
        const roomId = parts[1];
        const input = await body(request, 8192);
        if (parts.length === 4) {
          if (parts[3] !== "citation") throw new AuthError("NOT_FOUND", 404);
          const { citation, includeHistory, surrounding } =
            citationInput(input);
          const sources = new SearchSources(options.app, policy, actor, roomId);
          json(
            response,
            200,
            sources.resolve(citation, { includeHistory, surrounding }),
          );
        } else {
          const req = searchInput(input);
          const controller = new AbortController();
          const abort = () => controller.abort();
          response.once("close", abort);
          try {
            const result = await searchRoom(
              options.app,
              policy,
              actor,
              roomId,
              req,
              { purpose: "human", roomId, scope: req.target },
              controller.signal,
            );
            if (!response.destroyed) json(response, 200, result);
          } finally {
            response.off("close", abort);
          }
        }
        return;
      }
      if (memoryRoute) {
        const result = await handleMemory(actor, method, parts, url, () =>
          body(request),
        );
        json(response, 200, result);
        return;
      }
      if (parts[0] === "migrations") {
        policy.assert(actor, "IMPORT_DATA");
        if (parts[1] === "dry-run" && method === "POST") {
          const input = closed(
            await body(request, 16 * 1024 * 1024),
            ["sourceId", "rooms"],
            ["sourceId", "rooms"],
          );
          json(
            response,
            200,
            await requireService(imports).dryRun(actor, input),
          );
          return;
        }
        if (parts[1] === "import" && method === "POST") {
          const input = closed(
            await body(request, 16 * 1024 * 1024),
            ["requestId", "sourceId", "rooms"],
            ["requestId", "sourceId", "rooms"],
          );
          json(
            response,
            200,
            await requireService(imports).start(actor, input),
          );
          return;
        }
        if (parts.length === 2 && method === "GET") {
          json(
            response,
            200,
            await requireService(imports).status(actor, parts[1]),
          );
          return;
        }
      }
      if (parts[0] !== "rooms") throw new AuthError("NOT_FOUND", 404);
      if (parts.length === 1) {
        if (method === "GET") {
          json(response, 200, repo.listRooms(actor));
          return;
        }
        if (method === "POST") {
          json(
            response,
            201,
            repo.createRoom(
              actor,
              closed(
                await body(request),
                [
                  "title",
                  "description",
                  "type",
                  "systemInstruction",
                  "internalStateSettings",
                ],
                ["title"],
              ),
            ),
          );
          return;
        }
      }
      const roomId = parts[1];
      if (!roomId) throw new AuthError("NOT_FOUND", 404);
      if (parts.length === 2) {
        if (method === "GET") {
          json(response, 200, repo.getRoom(actor, roomId));
          return;
        }
        if (method === "PATCH") {
          json(
            response,
            200,
            repo.updateRoom(
              actor,
              roomId,
              closed(
                await body(request),
                [
                  "expectedRevision",
                  "title",
                  "description",
                  "type",
                  "systemInstruction",
                  "internalStateSettings",
                ],
                ["expectedRevision"],
              ),
            ),
          );
          return;
        }
        if (method === "DELETE") {
          const input = closed(
            await body(request, 1024),
            ["expectedRevision"],
            ["expectedRevision"],
          );
          json(
            response,
            200,
            repo.deleteRoom(actor, roomId, input) ?? { deleted: true },
          );
          return;
        }
      }
      if (parts[2] === "personas") {
        if (parts.length === 3 && method === "POST") {
          json(
            response,
            201,
            repo.createPersona(actor, roomId, await body(request)),
          );
          return;
        }
        if (parts.length === 4 && method === "GET") {
          json(response, 200, repo.getPersona(actor, roomId, parts[3]));
          return;
        }
        if (parts.length === 4 && method === "PATCH") {
          json(
            response,
            200,
            repo.updatePersona(actor, roomId, parts[3], await body(request)),
          );
          return;
        }
        if (parts.length === 4 && method === "DELETE") {
          const input = closed(
            await body(request, 1024),
            ["expectedRevision"],
            ["expectedRevision"],
          );
          json(
            response,
            200,
            repo.deletePersona(actor, roomId, parts[3], input) ?? {
              deleted: true,
            },
          );
          return;
        }
      }
      if (parts[2] === "messages") {
        if (parts.length === 3 && method === "GET") {
          if (
            [...url.searchParams.keys()].some(
              (x) => !["limit", "cursor"].includes(x),
            )
          )
            throw new AuthError("INVALID_INPUT", 400);
          const limit = url.searchParams.has("limit")
            ? Number(url.searchParams.get("limit"))
            : 50;
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
            throw new AuthError("INVALID_INPUT", 400);
          json(
            response,
            200,
            repo.listMessages(actor, roomId, {
              limit,
              ...(url.searchParams.has("cursor")
                ? { cursor: url.searchParams.get("cursor")! }
                : {}),
            }),
          );
          return;
        }
        if (parts.length === 4 && method === "PATCH") {
          json(
            response,
            200,
            repo.correctMessage(
              actor,
              roomId,
              parts[3],
              closed(
                await body(request),
                ["expectedRevision", "content"],
                ["expectedRevision", "content"],
              ),
            ),
          );
          return;
        }
        if (parts.length === 4 && method === "DELETE") {
          const input = closed(
            await body(request, 1024),
            ["expectedRevision"],
            ["expectedRevision"],
          );
          json(
            response,
            200,
            repo.deleteMessage(actor, roomId, parts[3], input) ?? {
              deleted: true,
            },
          );
          return;
        }
        if (
          parts.length === 6 &&
          parts[4] === "revisions" &&
          method === "GET"
        ) {
          const revision = Number(parts[5]);
          if (
            !/^[1-9][0-9]*$/.test(parts[5]) ||
            !Number.isSafeInteger(revision)
          ) {
            throw new AuthError("INVALID_INPUT", 400);
          }
          json(
            response,
            200,
            repo.getMessage(actor, roomId, parts[3], revision),
          );
          return;
        }
        if (parts.length === 5 && parts[4] === "history" && method === "GET") {
          json(response, 200, repo.history(actor, roomId, parts[3]));
          return;
        }
        if (parts.length === 5 && parts[4] === "private" && method === "GET") {
          const revision = url.searchParams.has("revision")
            ? Number(url.searchParams.get("revision"))
            : undefined;
          if (
            revision !== undefined &&
            (!Number.isSafeInteger(revision) || revision < 1)
          )
            throw new AuthError("INVALID_INPUT", 400);
          json(
            response,
            200,
            repo.readPrivateSegments(actor, roomId, parts[3], revision),
          );
          return;
        }
        if (
          parts.length === 5 &&
          parts[4] === "regenerate" &&
          method === "POST"
        ) {
          const input = closed(
            await body(request),
            ["requestId", "expectedRevision"],
            ["requestId", "expectedRevision"],
          );
          json(
            response,
            202,
            enqueue(
              await requireService(generation).regenerate(
                actor,
                roomId,
                parts[3],
                input,
              ),
            ),
          );
          return;
        }
      }
      if (parts[2] === "turns" && parts.length === 3 && method === "POST") {
        const input = closed(
          await body(request),
          [
            "requestId",
            "expectedRoomRevision",
            "content",
            "attachmentIds",
            "recipient",
          ],
          ["requestId", "expectedRoomRevision", "content"],
        );
        json(
          response,
          202,
          enqueue(
            await requireService(generation).accept(actor, roomId, input),
          ),
        );
        return;
      }
      if (parts[2] === "generations") {
        if (parts.length === 3 && method === "GET") {
          json(
            response,
            200,
            await requireService(generation).list(actor, roomId),
          );
          return;
        }
        if (parts.length === 4 && method === "GET") {
          json(
            response,
            200,
            await requireService(generation).get(actor, roomId, parts[3]),
          );
          return;
        }
        if (parts.length === 5 && parts[4] === "internal" && method === "GET") {
          json(
            response,
            200,
            await requireService(generation).readInternal(
              actor,
              roomId,
              parts[3],
            ),
          );
          return;
        }
        if (parts.length === 5 && parts[4] === "cancel" && method === "POST") {
          closed(await body(request, 1024), []);
          json(
            response,
            200,
            await requireService(generation).cancel(actor, roomId, parts[3]),
          );
          return;
        }
      }
      if (parts[2] === "attachments") {
        if (parts.length === 3 && method === "POST") {
          const input = closed(
            await body(request, 12 * 1024 * 1024),
            ["name", "mimeType", "data"],
            ["name", "mimeType", "data"],
          );
          if (
            typeof input.data !== "string" ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
              input.data,
            )
          )
            throw new AuthError("INVALID_INPUT", 400);
          json(
            response,
            201,
            await attachments.upload(actor, roomId, {
              ...input,
              data: Buffer.from(input.data, "base64"),
            }),
          );
          return;
        }
        if (parts.length === 4 && method === "GET") {
          json(
            response,
            200,
            await attachments.metadata(actor, roomId, parts[3]),
          );
          return;
        }
        if (parts.length === 4 && method === "DELETE") {
          closed(await body(request, 1024), []);
          attachments.delete(actor, roomId, parts[3]);
          json(response, 200, { deleted: true });
          return;
        }
        if (parts.length === 5 && parts[4] === "content" && method === "GET") {
          const meta = await attachments.metadata(actor, roomId, parts[3]),
            bytes = await attachments.read(actor, roomId, parts[3]);
          attachments.metadata(actor, roomId, parts[3]);
          response.writeHead(200, {
            "Content-Type": meta.mimeType ?? "application/octet-stream",
            "Content-Disposition": 'attachment; filename="attachment"',
            "Content-Security-Policy": "default-src 'none'; sandbox",
          });
          response.end(Buffer.isBuffer(bytes) ? bytes : bytes.data);
          return;
        }
      }
      if (parts[2] === "export" && parts.length === 3 && method === "GET") {
        if (
          [...url.searchParams.keys()].some(
            (x) => !["cursor", "limit"].includes(x),
          )
        )
          throw new AuthError("INVALID_INPUT", 400);
        const limit = url.searchParams.has("limit")
          ? Number(url.searchParams.get("limit"))
          : 50;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
          throw new AuthError("INVALID_INPUT", 400);
        json(
          response,
          200,
          await requireService(exporter).exportRoom(actor, roomId, {
            limit,
            ...(url.searchParams.has("cursor")
              ? { cursor: url.searchParams.get("cursor")! }
              : {}),
          }),
        );
        return;
      }
      throw new AuthError("NOT_FOUND", 404);
    } catch (error: any) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const code = SAFE_ERRORS.has(error?.code)
        ? error.code
        : "STORAGE_FAILURE";
      const status =
        Number.isInteger(error?.status) &&
        error.status >= 400 &&
        error.status <= 599
          ? error.status
          : code === "UNAUTHENTICATED"
            ? 401
            : code === "FORBIDDEN"
              ? 403
              : code === "NOT_FOUND"
                ? 404
                : /CONFLICT|REVISION/.test(code)
                  ? 409
                  : /INPUT|CURSOR|INVALID/.test(code)
                    ? 400
                    : code === "TOO_LARGE"
                      ? 413
                      : 500;
      json(response, status, { error: { code } });
    }
  };
}

export function createAppServer(options: AppServerOptions) {
  if (!options.development && !options.trustedProxy)
    throw new AuthError("TLS_REQUIRED", 500);
  const server = createServer(createAppHandler(options));
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 64;
  return server;
}
