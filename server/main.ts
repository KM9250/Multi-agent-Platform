import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AppDatabase } from "./app-data/db.ts";
import { ConversationRepository } from "./app-data/repository.ts";
import { AttachmentStore } from "./attachments/store.ts";
import { AuthorizationPolicy, AuthError } from "./auth/authorization.ts";
import { SessionService } from "./auth/sessions.ts";
import { createAppHandler, createAppServer } from "./http/server.ts";
import { protectedDataRoot } from "./http/config.ts";
import { GenerationCoordinator } from "./generation/coordinator.ts";
import {
  GeminiProvider,
  FakeProvider,
  UnavailableProvider,
} from "./generation/provider.ts";
import { ImportService } from "./operations/import.ts";
import { ExportService } from "./operations/export.ts";
import { acquireHostLock, assertOperationalRoot } from "./operations/locks.ts";
import { inspectDataHealth } from "./operations/health.ts";
import { startLineageWorker, startPublicationWorker } from "./memory/worker.ts";
import { startVaultWatcher } from "./memory/importer.ts";

import { recoverSearchDispatches } from "./search/profile.ts";
import { shutdownIndexWorkers } from "./search/index.ts";

function numberSetting(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new AuthError("INVALID_CONFIGURATION", 500);
  return n;
}
/** Host-only environment configuration. Browser input cannot choose URLs or credentials. */
export function hostConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const development = env.MAP_DEV_HTTP === "1",
    host = env.MAP_HOST ?? "127.0.0.1",
    port = numberSetting(env.MAP_PORT, 3001, 1, 65535);
  if (!env.MAP_DATA_ROOT || !env.MAP_ORIGIN)
    throw new AuthError("INVALID_CONFIGURATION", 500);
  if (development && !["127.0.0.1", "::1", "localhost"].includes(host))
    throw new AuthError("INVALID_CONFIGURATION", 500);
  const trustedProxy = env.MAP_TRUST_LOOPBACK_PROXY === "1";
  if (trustedProxy && (!["127.0.0.1", "::1"].includes(host) || development))
    throw new AuthError("INVALID_CONFIGURATION", 500);
  if (!development && !trustedProxy && (!env.MAP_TLS_CERT || !env.MAP_TLS_KEY))
    throw new AuthError("TLS_REQUIRED", 500);
  const providerMode = env.MAP_PROVIDER ?? "gemini";
  if (!["gemini", "fake", "unavailable"].includes(providerMode))
    throw new AuthError("INVALID_CONFIGURATION", 500);
  if (providerMode !== "gemini" && !development)
    throw new AuthError("INVALID_CONFIGURATION", 500);
  const allowedModels = (env.MAP_MODELS ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (
    providerMode === "gemini" &&
    (!env.GEMINI_API_KEY ||
      !allowedModels.length ||
      !env.MAP_DEFAULT_MODEL ||
      !allowedModels.includes(env.MAP_DEFAULT_MODEL))
  )
    throw new AuthError("PROVIDER_CONFIGURATION_REQUIRED", 500);
  const defaultModel =
    providerMode === "fake"
      ? "synthetic"
      : providerMode === "unavailable"
        ? "unconfigured"
        : env.MAP_DEFAULT_MODEL!;
  const pricing = {
    ...(env.MAP_PRICING_CURRENCY ? { currency: env.MAP_PRICING_CURRENCY } : {}),
    version:
      env.MAP_PRICING_VERSION ??
      (providerMode !== "gemini" ? "synthetic-v1" : ""),
    inputMicrosPerMillion: numberSetting(
      env.MAP_INPUT_MICROS_PER_MILLION,
      providerMode !== "gemini" ? 0 : -1,
      0,
      1_000_000_000,
    ),
    outputMicrosPerMillion: numberSetting(
      env.MAP_OUTPUT_MICROS_PER_MILLION,
      providerMode !== "gemini" ? 0 : -1,
      0,
      1_000_000_000,
    ),
  };
  if (!pricing.version) throw new AuthError("PRICING_REQUIRED", 500);
  if (pricing.currency !== undefined && !/^[A-Z]{3}$/.test(pricing.currency))
    throw new AuthError("INVALID_PRICING_CURRENCY", 500);
  const staticRoot = resolve(env.MAP_STATIC_ROOT ?? "dist"),
    root = protectedDataRoot(env.MAP_DATA_ROOT, staticRoot);
  return {
    development,
    host,
    port,
    root,
    origin: env.MAP_ORIGIN,
    trustedProxy,
    providerMode,
    allowedModels:
      providerMode === "fake"
        ? [defaultModel]
        : providerMode === "unavailable"
          ? []
          : allowedModels,
    defaultModel,
    pricing,
    tlsCert: env.MAP_TLS_CERT,
    tlsKey: env.MAP_TLS_KEY,
    staticRoot,
  };
}

export async function startServer(env: NodeJS.ProcessEnv = process.env) {
  const config = hostConfiguration(env);
  assertOperationalRoot(config.root);
  const release = acquireHostLock(config.root);
  let app: AppDatabase | undefined;
  try {
    app = new AppDatabase({ root: config.root });
    if (
      !app.db
        .prepare(
          "SELECT 1 FROM auth_accounts a JOIN principals p ON p.actor_id=a.actor_id WHERE p.active=1 LIMIT 1",
        )
        .get()
    )
      throw new AuthError("INITIAL_ACCOUNT_REQUIRED", 500);
    process.stdout.write(
      JSON.stringify({
        event: "data_health",
        ...(await inspectDataHealth(app, { retentionMode: "manual" })),
      }) + "\n",
    );
    const sessions = new SessionService(app),
      policy = new AuthorizationPolicy(app),
      repository = new ConversationRepository(app, policy),
      attachments = new AttachmentStore(app, policy);
    const provider =
      config.providerMode === "fake"
        ? new FakeProvider()
        : config.providerMode === "unavailable"
          ? new UnavailableProvider()
          : new GeminiProvider({
              apiKey: env.GEMINI_API_KEY!,
              allowedModels: config.allowedModels,
            });
    const generation = new GenerationCoordinator(app, repository, policy, {
      provider,
      defaultModel: config.defaultModel,
      pricing: config.pricing,
      attachmentStore: attachments,
    } as any);
    const imports = new ImportService(app, repository, attachments, policy),
      exports = new ExportService(app, repository, attachments, policy);
    const options = {
      app,
      sessions,
      policy,
      repository,
      attachments,
      generation,
      imports,
      exports,
      origin: config.origin,
      development: config.development,
      trustedProxy: config.trustedProxy,
      staticRoot: config.staticRoot,
      allowedModels: config.allowedModels,
      onRequest: (entry: any) =>
        process.stdout.write(
          JSON.stringify({ event: "http_request", ...entry }) + "\n",
        ),
    };
    const server =
      !config.development && !config.trustedProxy
        ? createHttpsServer(
            {
              cert: readFileSync(config.tlsCert!),
              key: readFileSync(config.tlsKey!),
            },
            createAppHandler(options),
          )
        : createAppServer(options);
    generation.recoverInterrupted();
    recoverSearchDispatches(app);
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    server.maxHeadersCount = 64;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => resolve());
    });
    const stopLineage = startLineageWorker(app);
    const stopPublisher = startPublicationWorker(app, policy);
    const stopWatching = startVaultWatcher(app);
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      stopLineage();
      stopPublisher();
      await stopWatching();
      await shutdownIndexWorkers(app!);
      await generation.shutdown();
      app!.close();
      release();
    };
    return { server, app, generation, close, config };
  } catch (error) {
    app?.close();
    release();
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  startServer()
    .then((runtime) => {
      process.stdout.write(
        JSON.stringify({
          event: "server_started",
          origin: runtime.config.origin,
          provider: runtime.config.providerMode,
        }) + "\n",
      );
      for (const signal of ["SIGINT", "SIGTERM"] as const)
        process.once(signal, () => {
          runtime.close().then(
            () => process.exit(0),
            () => process.exit(1),
          );
        });
    })
    .catch((error: any) => {
      process.stderr.write(
        JSON.stringify({
          error: {
            code: /^[A-Z0-9_]+$/.test(error?.code ?? "")
              ? error.code
              : "STARTUP_FAILED",
          },
        }) + "\n",
      );
      process.exitCode = 1;
    });
}
