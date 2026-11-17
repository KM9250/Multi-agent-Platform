import { randomUUID } from "node:crypto";
import type {
  Actor,
  AuthorizationPort,
} from "../../shared/app-contracts/index.ts";
import { securePolicy } from "../app-data/validation.ts";
import type { AppDatabase } from "../app-data/db.ts";
import {
  hash,
  json,
  prepareLegacy,
  OperationError,
  IMPORT_LIMITS,
  type LegacyManifest,
  type LegacyAttachment,
} from "./legacy.ts";

const yieldEventLoop = () =>
  new Promise<void>((resolve) => setImmediate(resolve));
/** Import is a publication barrier, not one unbounded SQLite transaction. */
export class ImportService {
  constructor(
    readonly app: AppDatabase,
    readonly repository: any,
    readonly attachments: any,
    readonly policy: AuthorizationPort,
    readonly hooks: {
      afterItem?: (kind: string, sourceKey: string) => void | Promise<void>;
    } = {},
  ) {
    this.policy = securePolicy(policy);
  }

  dryRun(actor: Actor, input: unknown) {
    this.policy.assert(actor, "IMPORT_DATA");
    const manifest = prepareLegacy(input);
    this.checkConflicts(actor, manifest);
    return {
      schema: 1,
      manifestDigest: manifest.digest,
      sourceId: manifest.sourceId,
      counts: manifest.counts,
      warnings: manifest.warnings,
      limits: IMPORT_LIMITS,
      changes: [
        "SERVER_ASSIGNED_IDS",
        "BASE64_TO_ATTACHMENT_STORE",
        "INCOMPLETE_GENERATIONS_NOT_RESUMED",
      ],
      encrypted: false,
    };
  }

  private entries(
    manifest: LegacyManifest,
  ): { kind: string; key: string; digest: string }[] {
    const entries: { kind: string; key: string; digest: string }[] = [];
    for (const r of manifest.rooms) {
      entries.push({ kind: "room", key: r.oldId, digest: r.sourceDigest });
      for (const p of r.personas)
        entries.push({
          kind: "persona",
          key: `${r.oldId}/${p.oldId}`,
          digest: p.sourceDigest,
        });
      for (const m of r.messages)
        entries.push({
          kind: "message",
          key: `${r.oldId}/${m.oldId}`,
          digest: m.sourceDigest,
        });
      for (const d of r.decisions)
        entries.push({
          kind: "decision",
          key: `${r.oldId}/${d.id}`,
          digest: hash(json(d)),
        });
      for (const reaction of r.reactions)
        entries.push({
          kind: "reaction",
          key: `${r.oldId}/${reaction.id}`,
          digest: hash(json(reaction)),
        });
    }
    return entries;
  }
  private checkConflicts(actor: Actor, manifest: LegacyManifest): void {
    const query = this.app.db.prepare(
      "SELECT source_digest FROM import_source_registry WHERE workspace_id=? AND actor_id=? AND kind=? AND source_key=?",
    );
    for (const entry of this.entries(manifest)) {
      const rows = query.all(
        actor.workspaceId,
        actor.actorId,
        entry.kind,
        entry.key,
      );
      if (rows.some((row) => row.source_digest !== entry.digest))
        throw new OperationError("IMPORT_SOURCE_CONFLICT", 409);
    }
  }
  private batch(actor: Actor, batchId: string): any {
    this.policy.assert(actor, "IMPORT_DATA");
    const row = this.app.db
      .prepare(
        "SELECT * FROM import_batches WHERE workspace_id=? AND actor_id=? AND batch_id=?",
      )
      .get(actor.workspaceId, actor.actorId, batchId);
    if (!row) throw new OperationError("NOT_FOUND", 404);
    return row;
  }
  status(actor: Actor, batchId: string) {
    const row = this.batch(actor, batchId);
    const details = JSON.parse(String(row.manifest_json));
    const mappings = this.app.db
      .prepare(
        "SELECT kind,source_key,target_id,source_digest,target_digest,details_json FROM import_item_map WHERE workspace_id=? AND batch_id=? ORDER BY kind,source_key",
      )
      .all(actor.workspaceId, batchId);
    // Raw legacy bodies, private classifications and unfiltered digests are not exposed by import status.
    return {
      batchId,
      status: row.status,
      manifestDigest: row.manifest_digest,
      counts: details.counts,
      warnings: details.warnings,
      completedAt: row.completed_at,
      progress: mappings.length,
      reconciliation: row.reconciliation_json
        ? JSON.parse(String(row.reconciliation_json))
        : null,
      mappings: mappings
        .filter((m) =>
          ["room", "persona", "message", "attachment"].includes(String(m.kind)),
        )
        .map((m) => ({
          kind: m.kind,
          sourceKey: m.source_key,
          targetId: m.target_id,
          changes: JSON.parse(String(m.details_json)).changes ?? [],
        })),
    };
  }

  async start(actor: Actor, input: any) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new OperationError("IMPORT_INVALID");
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (
      Object.keys(descriptors).some(
        (key) =>
          !["requestId", "sourceId", "rooms"].includes(key) ||
          !("value" in descriptors[key]),
      )
    )
      throw new OperationError("IMPORT_INVALID");
    const requestId = input.requestId;
    if (typeof requestId !== "string" || !requestId || requestId.length > 200)
      throw new OperationError("IMPORT_INVALID");
    this.policy.assert(actor, "IMPORT_DATA");
    const manifest = prepareLegacy({
      sourceId: input.sourceId,
      rooms: input.rooms,
    });
    const batchId = this.app.transaction(() => {
      this.policy.assert(actor, "IMPORT_DATA");
      this.checkConflicts(actor, manifest);
      const request = this.app.db
        .prepare(
          "SELECT batch_id,manifest_digest,source_id FROM import_requests WHERE workspace_id=? AND actor_id=? AND request_id=?",
        )
        .get(actor.workspaceId, actor.actorId, requestId);
      if (request) {
        if (
          request.manifest_digest !== manifest.digest ||
          request.source_id !== manifest.sourceId
        )
          throw new OperationError("IDEMPOTENCY_CONFLICT", 409);
        return String(request.batch_id);
      }
      const previous = this.app.db
        .prepare(
          "SELECT batch_id FROM import_batches WHERE workspace_id=? AND actor_id=? AND source_id=? AND manifest_digest=?",
        )
        .get(
          actor.workspaceId,
          actor.actorId,
          manifest.sourceId,
          manifest.digest,
        );
      if (previous) {
        this.app.db
          .prepare("INSERT INTO import_requests VALUES(?,?,?,?,?,?)")
          .run(
            actor.workspaceId,
            actor.actorId,
            requestId,
            manifest.sourceId,
            manifest.digest,
            previous.batch_id,
          );
        return String(previous.batch_id);
      }
      const batchId = randomUUID();
      this.app.db
        .prepare(
          "INSERT INTO import_batches(workspace_id,batch_id,actor_id,source_id,request_id,manifest_digest,status,manifest_json,created_at) VALUES(?,?,?,?,?,?,'STAGING',?,?)",
        )
        .run(
          actor.workspaceId,
          batchId,
          actor.actorId,
          manifest.sourceId,
          requestId,
          manifest.digest,
          json({ counts: manifest.counts, warnings: manifest.warnings }),
          Date.now(),
        );
      this.app.db
        .prepare("INSERT INTO import_requests VALUES(?,?,?,?,?,?)")
        .run(
          actor.workspaceId,
          actor.actorId,
          requestId,
          manifest.sourceId,
          manifest.digest,
          batchId,
        );
      this.app.audit(
        actor.actorId,
        actor.workspaceId,
        "IMPORT_ACCEPT",
        batchId,
      );
      return batchId;
    }, "import-accept");
    if (this.batch(actor, batchId).status === "COMPLETE")
      return this.status(actor, batchId);

    for (const room of manifest.rooms) {
      this.policy.assert(actor, "IMPORT_DATA");
      const roomId = this.item(
        actor,
        batchId,
        manifest.sourceId,
        "room",
        room.oldId,
        room.sourceDigest,
        () => {
          const created = this.repository.withImport(batchId, () =>
            this.repository.createRoom(actor, room.config, {
              importBatchId: batchId,
            }),
          );
          return {
            id: created.id,
            digest: hash(json(room.config)),
            details: { changes: ["SERVER_ASSIGNED_ID"] },
          };
        },
      );
      const personas = new Map<string, string>();
      for (const persona of room.personas) {
        const config = { ...persona.config };
        const contextIds: string[] = [];
        for (const value of persona.attachments) {
          const attachmentId = await this.importAttachment(
            actor,
            batchId,
            manifest.sourceId,
            roomId,
            `${room.oldId}/persona/${persona.oldId}/${value.originalId}`,
            value.attachment,
          );
          if (value.purpose === "avatar")
            config.avatarAttachmentId = attachmentId;
          else contextIds.push(attachmentId);
        }
        if (contextIds.length) config.contextAttachmentIds = contextIds;
        const personaId = this.item(
          actor,
          batchId,
          manifest.sourceId,
          "persona",
          `${room.oldId}/${persona.oldId}`,
          persona.sourceDigest,
          () => {
            const created = this.repository.withImport(batchId, () =>
              config.historicalIdentity
                ? this.repository.createHistoricalPersona(
                    actor,
                    roomId,
                    config.historicalIdentity,
                  )
                : this.repository.createPersona(actor, roomId, config),
            );
            const stored = this.app.db
              .prepare(
                "SELECT config_json FROM persona_revisions WHERE workspace_id=? AND persona_id=? AND revision=1",
              )
              .get(actor.workspaceId, created.id)!;
            return {
              id: created.id,
              digest: hash(String(stored.config_json)),
              details: {
                changes: [
                  "SERVER_ASSIGNED_ID",
                  "ROOM_SCOPED_PERSONA",
                  ...(config.historicalIdentity
                    ? ["HISTORY_ONLY_NOT_EXECUTABLE"]
                    : []),
                ],
              },
            };
          },
        );
        personas.set(persona.oldId, personaId);
        await this.hooks.afterItem?.("persona", persona.oldId);
        await yieldEventLoop();
      }
      const messages = new Map<string, string>();
      for (const message of room.messages) {
        const attachmentIds: string[] = [];
        for (const attachment of message.attachments)
          attachmentIds.push(
            await this.importAttachment(
              actor,
              batchId,
              manifest.sourceId,
              roomId,
              `${room.oldId}/message/${message.oldId}/${attachment.oldId}`,
              attachment,
            ),
          );
        const messageId = this.item(
          actor,
          batchId,
          manifest.sourceId,
          "message",
          `${room.oldId}/${message.oldId}`,
          message.sourceDigest,
          () => {
            const created = this.repository.withImport(batchId, () =>
              this.repository.appendMessage(actor, roomId, {
                role: message.role,
                ...(message.personaOldId
                  ? { personaId: personas.get(message.personaOldId) }
                  : {}),
                segments: message.segments.map((s) => ({
                  channel: s.channel,
                  visibility: s.visibility,
                  content: s.content,
                })),
                attachmentIds,
                occurredAt: message.occurredAt,
                reason: "IMPORT",
              }),
            );
            this.app.db
              .prepare(
                "INSERT INTO import_source_records VALUES(?,?,?,?,?,?,?,?)",
              )
              .run(
                actor.workspaceId,
                batchId,
                roomId,
                created.id,
                message.content,
                hash(message.content),
                message.timeTrust,
                message.incomplete ? 1 : 0,
              );
            return {
              id: created.id,
              digest: hash(
                json(
                  message.segments.map((s) => ({
                    channel: s.channel,
                    visibility: s.visibility,
                    content: s.content,
                  })),
                ),
              ),
              details: {
                changes: [
                  "SERVER_ASSIGNED_ID",
                  ...(message.incomplete ? ["UNFINISHED_NOT_RESUMED"] : []),
                ],
                legacyId: message.oldId,
                legacyRoomId: room.oldId,
                originalContentDigest: hash(message.content),
                segments: message.segments.map((s) => ({
                  sourceId: s.oldId,
                  digest: s.digest,
                  channel: s.channel,
                  visibility: s.visibility,
                })),
                occurredAt: message.occurredAt,
                timeTrust: message.timeTrust,
              },
            };
          },
        );
        messages.set(message.oldId, messageId);
        await this.hooks.afterItem?.("message", message.oldId);
        await yieldEventLoop();
      }
      for (const decision of room.decisions) {
        this.item(
          actor,
          batchId,
          manifest.sourceId,
          "decision",
          `${room.oldId}/${decision.id}`,
          hash(json(decision)),
          () => {
            const decisionId = randomUUID();
            this.app.db
              .prepare("INSERT INTO import_decisions VALUES(?,?,?,?,?,?,?,?)")
              .run(
                actor.workspaceId,
                batchId,
                roomId,
                decisionId,
                personas.get(decision.agentId)!,
                decision.turnId,
                json(decision),
                hash(json(decision)),
              );
            return {
              id: decisionId,
              digest: hash(json(decision)),
              details: {
                legacyId: decision.id,
                legacyRoomId: room.oldId,
                changes: ["LEGACY_EVENT_NOT_EXECUTION_RECEIPT"],
              },
            };
          },
        );
        await yieldEventLoop();
      }
      for (const reaction of room.reactions) {
        this.item(
          actor,
          batchId,
          manifest.sourceId,
          "reaction",
          `${room.oldId}/${reaction.id}`,
          hash(json(reaction)),
          () => {
            const reactionId = randomUUID();
            this.app.db
              .prepare(
                "INSERT INTO import_reactions VALUES(?,?,?,?,?,?,?,?,?,?)",
              )
              .run(
                actor.workspaceId,
                batchId,
                roomId,
                reactionId,
                messages.get(reaction.messageId)!,
                personas.get(reaction.agentId)!,
                reaction.turnId,
                reaction.semantic,
                reaction.timestamp ?? 0,
                hash(json(reaction)),
              );
            return {
              id: reactionId,
              digest: hash(json(reaction)),
              details: {
                legacyId: reaction.id,
                legacyRoomId: room.oldId,
                changes: ["SERVER_ASSIGNED_ID"],
              },
            };
          },
        );
        await yieldEventLoop();
      }
      await this.hooks.afterItem?.("room", room.oldId);
    }
    await this.reconcile(actor, batchId, manifest);
    return this.status(actor, batchId);
  }

  private item(
    actor: Actor,
    batchId: string,
    sourceId: string,
    kind: string,
    sourceKey: string,
    sourceDigest: string,
    create: () => { id: string; digest: string; details: any },
  ): string {
    return this.app.transaction(() => {
      this.policy.assert(actor, "IMPORT_DATA");
      const existing = this.app.db
        .prepare(
          "SELECT target_id,source_digest FROM import_item_map WHERE workspace_id=? AND batch_id=? AND kind=? AND source_key=?",
        )
        .get(actor.workspaceId, batchId, kind, sourceKey);
      if (existing) {
        if (existing.source_digest !== sourceDigest)
          throw new OperationError("IMPORT_SOURCE_CONFLICT", 409);
        return String(existing.target_id);
      }
      const previous = this.app.db
        .prepare(
          `SELECT m.*,b.status FROM import_source_registry s JOIN import_item_map m ON m.workspace_id=s.workspace_id AND m.batch_id=s.batch_id AND m.kind=s.kind AND m.source_key=s.source_key JOIN import_batches b ON b.workspace_id=m.workspace_id AND b.batch_id=m.batch_id WHERE s.workspace_id=? AND s.actor_id=? AND s.kind=? AND s.source_key=? AND b.status='COMPLETE' LIMIT 1`,
        )
        .get(actor.workspaceId, actor.actorId, kind, sourceKey);
      if (previous && previous.source_digest !== sourceDigest)
        throw new OperationError("IMPORT_SOURCE_CONFLICT", 409);
      const result = previous
        ? {
            id: String(previous.target_id),
            digest: String(previous.target_digest),
            details: JSON.parse(String(previous.details_json)),
          }
        : create();
      this.app.db
        .prepare("INSERT INTO import_item_map VALUES(?,?,?,?,?,?,?,?)")
        .run(
          actor.workspaceId,
          batchId,
          kind,
          sourceKey,
          sourceDigest,
          result.id,
          result.digest,
          json(result.details),
        );
      this.app.db
        .prepare("INSERT INTO import_source_registry VALUES(?,?,?,?,?,?,?)")
        .run(
          actor.workspaceId,
          actor.actorId,
          sourceId,
          kind,
          sourceKey,
          sourceDigest,
          batchId,
        );
      return result.id;
    }, "import-item");
  }
  private async importAttachment(
    actor: Actor,
    batchId: string,
    sourceId: string,
    roomId: string,
    key: string,
    value: LegacyAttachment,
  ): Promise<string> {
    const existing = this.app.db
      .prepare(
        "SELECT target_id,source_digest FROM import_item_map WHERE workspace_id=? AND batch_id=? AND kind='attachment' AND source_key=?",
      )
      .get(actor.workspaceId, batchId, key);
    if (existing) {
      if (existing.source_digest !== value.sourceDigest)
        throw new OperationError("IMPORT_SOURCE_CONFLICT", 409);
      return String(existing.target_id);
    }
    // Durable blob creation is separate from DB linkage; a stopped upload remains a safe orphan.
    const identity = hash(
      `${actor.workspaceId}:${actor.actorId}:${key}:${value.sourceDigest}`,
    );
    const attachmentId = `${identity.slice(0, 8)}-${identity.slice(8, 12)}-${identity.slice(12, 16)}-${identity.slice(16, 20)}-${identity.slice(20, 32)}`;
    const upload = await this.attachments.upload(
      actor,
      roomId,
      { name: value.name, mimeType: value.mimeType, data: value.data },
      { attachmentId },
    );
    if (upload.digest !== value.digest)
      throw new OperationError("IMPORT_DIGEST_MISMATCH", 409);
    return this.item(
      actor,
      batchId,
      sourceId,
      "attachment",
      key,
      value.sourceDigest,
      () => ({
        id: upload.id,
        digest: value.digest,
        details: {
          roomId,
          size: value.data.length,
          changes: ["BASE64_TO_BINARY", "SERVER_ASSIGNED_ID"],
        },
      }),
    );
  }
  private async reconcile(
    actor: Actor,
    batchId: string,
    manifest: LegacyManifest,
  ): Promise<void> {
    const mappings = this.app.db
      .prepare(
        "SELECT * FROM import_item_map WHERE workspace_id=? AND batch_id=? ORDER BY kind,source_key",
      )
      .all(actor.workspaceId, batchId);
    const actual = {
      rooms: 0,
      personas: 0,
      messages: 0,
      revisions: 0,
      segments: 0,
      decisions: 0,
      reactions: 0,
      attachments: 0,
    };
    for (const row of mappings) {
      this.policy.assert(actor, "IMPORT_DATA");
      const target = String(row.target_id),
        details = JSON.parse(String(row.details_json));
      if (row.kind === "room") {
        actual.rooms++;
        if (
          !this.app.db
            .prepare(
              "SELECT 1 FROM rooms WHERE workspace_id=? AND room_id=? AND deleted_at IS NULL",
            )
            .get(actor.workspaceId, target)
        )
          throw new OperationError("IMPORT_RECONCILIATION_FAILED", 409);
      } else if (row.kind === "persona") {
        actual.personas++;
        const p = this.app.db
          .prepare(
            "SELECT config_json FROM persona_revisions WHERE workspace_id=? AND persona_id=? AND revision=1",
          )
          .get(actor.workspaceId, target);
        if (!p || hash(String(p.config_json)) !== row.target_digest)
          throw new OperationError("IMPORT_RECONCILIATION_FAILED", 409);
      } else if (row.kind === "message") {
        actual.messages++;
        actual.revisions++;
        const source = this.app.db
          .prepare(
            "SELECT * FROM import_source_records WHERE workspace_id=? AND message_id=?",
          )
          .get(actor.workspaceId, target);
        if (
          !source ||
          hash(String(source.original_content)) !==
            details.originalContentDigest
        )
          throw new OperationError("IMPORT_RECONCILIATION_FAILED", 409);
        const segments = this.app.db
          .prepare(
            "SELECT channel,visibility,content,digest FROM message_segments WHERE workspace_id=? AND room_id=? AND message_id=? AND revision=1 ORDER BY rowid",
          )
          .all(actor.workspaceId, source.room_id, target);
        actual.segments += segments.length;
        if (
          segments.length !== details.segments.length ||
          segments.some(
            (s, i) =>
              s.digest !== details.segments[i].digest ||
              hash(String(s.content)) !== s.digest ||
              s.channel !== details.segments[i].channel ||
              s.visibility !== details.segments[i].visibility,
          )
        )
          throw new OperationError("IMPORT_RECONCILIATION_FAILED", 409);
        const m = this.app.db
          .prepare(
            "SELECT occurred_at FROM messages WHERE workspace_id=? AND room_id=? AND message_id=?",
          )
          .get(actor.workspaceId, source.room_id, target);
        if (m?.occurred_at !== details.occurredAt)
          throw new OperationError("IMPORT_RECONCILIATION_FAILED", 409);
      } else if (row.kind === "attachment") {
        actual.attachments++;
        // AttachmentStore reopens without symlink following and verifies every byte against its digest.
        const room = this.app.db
          .prepare(
            "SELECT import_batch_id FROM rooms WHERE workspace_id=? AND room_id=?",
          )
          .get(actor.workspaceId, details.roomId);
        const original = await this.attachments.readForImport(
          actor,
          details.roomId,
          target,
          String(room?.import_batch_id ?? batchId),
        );
        if (
          hash(original.data) !== row.target_digest ||
          original.data.length !== details.size
        )
          throw new OperationError("IMPORT_RECONCILIATION_FAILED", 409);
      } else if (row.kind === "decision") {
        actual.decisions++;
        const d = this.app.db
          .prepare(
            "SELECT payload_json FROM import_decisions WHERE workspace_id=? AND decision_id=?",
          )
          .get(actor.workspaceId, target);
        if (!d || hash(String(d.payload_json)) !== row.target_digest)
          throw new OperationError("IMPORT_RECONCILIATION_FAILED", 409);
      } else if (row.kind === "reaction") {
        actual.reactions++;
        const r = this.app.db
          .prepare(
            "SELECT source_digest FROM import_reactions WHERE workspace_id=? AND reaction_id=?",
          )
          .get(actor.workspaceId, target);
        if (r?.source_digest !== row.target_digest)
          throw new OperationError("IMPORT_RECONCILIATION_FAILED", 409);
      }
      await yieldEventLoop();
    }
    if (Object.keys(actual).some((key) => actual[key] !== manifest.counts[key]))
      throw new OperationError("IMPORT_RECONCILIATION_FAILED", 409);
    this.app.transaction(() => {
      this.policy.assert(actor, "IMPORT_DATA");
      const row = this.batch(actor, batchId);
      if (row.status === "COMPLETE") return;
      this.app.db
        .prepare(
          "UPDATE import_batches SET status='COMPLETE',completed_at=?,reconciliation_json=? WHERE workspace_id=? AND batch_id=? AND status='STAGING'",
        )
        .run(
          Date.now(),
          json({
            counts: actual,
            digestsVerified: true,
            timestampsVerified: true,
            unresolved: 0,
          }),
          actor.workspaceId,
          batchId,
        );
      this.app.audit(
        actor.actorId,
        actor.workspaceId,
        "IMPORT_COMPLETE",
        batchId,
      );
    }, "import-publish");
  }
}
