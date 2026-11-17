import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type {
  Actor,
  AuthorizationPort,
} from "../../shared/app-contracts/index.ts";
import { securePolicy } from "../app-data/validation.ts";
import type { AppDatabase } from "../app-data/db.ts";
import { hash, json, OperationError } from "./legacy.ts";

/** Each chunk reauthorizes its audience. No raw storage sequence/count crosses this API. */
export class ExportService {
  constructor(
    readonly app: AppDatabase,
    readonly repository: any,
    readonly attachments: any,
    readonly policy: AuthorizationPort,
  ) {
    this.policy = securePolicy(policy);
  }
  private cursor(
    actor: Actor,
    roomId: string,
    acl: unknown,
    seq: number,
  ): string {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.app.cursorKey, iv);
    const encrypted = Buffer.concat([
      cipher.update(
        json({
          purpose: "export",
          actor: actor.actorId,
          workspace: actor.workspaceId,
          roomId,
          acl,
          seq,
          expires: Date.now() + 1800000,
        }),
      ),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
      "base64url",
    );
  }
  private sequence(
    actor: Actor,
    roomId: string,
    acl: unknown,
    cursor?: string,
  ): number {
    if (!cursor) return Number.MAX_SAFE_INTEGER;
    try {
      if (typeof cursor !== "string" || cursor.length > 2000) throw new Error();
      const encoded = Buffer.from(cursor, "base64url"),
        decipher = createDecipheriv(
          "aes-256-gcm",
          this.app.cursorKey,
          encoded.subarray(0, 12),
        );
      decipher.setAuthTag(encoded.subarray(12, 28));
      const value = JSON.parse(
        Buffer.concat([
          decipher.update(encoded.subarray(28)),
          decipher.final(),
        ]).toString(),
      );
      if (
        value.purpose !== "export" ||
        value.actor !== actor.actorId ||
        value.workspace !== actor.workspaceId ||
        value.roomId !== roomId ||
        value.acl !== acl ||
        value.expires < Date.now() ||
        !Number.isSafeInteger(value.seq) ||
        value.seq < 1
      )
        throw new Error();
      return value.seq;
    } catch {
      throw new OperationError("INVALID_CURSOR", 409);
    }
  }
  private legacySources(actor: Actor, targetId: string, kind: string) {
    const rows = this.app.db
      .prepare(
        "SELECT b.source_id,m.source_key,m.details_json FROM import_item_map m JOIN import_batches b USING(workspace_id,batch_id) WHERE m.workspace_id=? AND m.target_id=? AND m.kind=? AND b.status='COMPLETE' LIMIT 51",
      )
      .all(actor.workspaceId, targetId, kind);
    if (rows.length > 50) throw new OperationError("EXPORT_SOURCE_LIMIT", 413);
    return rows.map((row) => {
      const details = JSON.parse(String(row.details_json));
      return {
        sourceId: row.source_id,
        sourceKey: row.source_key,
        ...(details.legacyId
          ? { legacyId: details.legacyId, legacyRoomId: details.legacyRoomId }
          : {}),
      };
    });
  }
  async exportRoom(
    actor: Actor,
    roomId: string,
    options: { cursor?: string; limit?: number } = {},
  ) {
    this.policy.assert(actor, "EXPORT_DATA", { roomId });
    const room = this.repository.getRoom(actor, roomId);
    const aclRevision = this.app.db
      .prepare("SELECT acl_revision FROM workspaces WHERE workspace_id=?")
      .get(actor.workspaceId)!.acl_revision;
    const limit = options.limit ?? 50;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      Object.keys(options).some((k) => !["cursor", "limit"].includes(k))
    )
      throw new OperationError("INVALID_INPUT");
    const sequence = this.sequence(actor, roomId, aclRevision, options.cursor);
    const page = this.app.db
      .prepare(
        `SELECT m.* FROM messages m WHERE m.workspace_id=? AND m.room_id=? AND m.deleted_at IS NULL AND m.seq<?
      AND (m.persona_id IS NULL OR EXISTS(SELECT 1 FROM personas p WHERE p.workspace_id=m.workspace_id AND p.persona_id=m.persona_id AND p.deleted_at IS NULL))
      AND EXISTS(SELECT 1 FROM message_segments s WHERE s.workspace_id=m.workspace_id AND s.room_id=m.room_id AND s.message_id=m.message_id AND s.revision=m.current_revision AND
        ((s.visibility='public' AND s.channel IN ('public_message','shared_summary')) OR EXISTS(SELECT 1 FROM access_grants g WHERE g.workspace_id=s.workspace_id AND g.actor_id=? AND g.operation='READ_PRIVATE_SEGMENT' AND g.room_id=s.room_id AND g.persona_id=s.owner_persona_id AND g.visibility=s.visibility AND g.provider IN ('*','') AND g.revoked_at IS NULL)))
      ORDER BY m.seq DESC LIMIT ?`,
      )
      .all(actor.workspaceId, roomId, sequence, actor.actorId, limit + 1);
    const messages: any[] = [];
    const attachmentManifest = new Map<string, unknown>();
    for (const persona of room.agents) {
      const authorized = (attachmentId: string): boolean => {
        try {
          attachmentManifest.set(
            attachmentId,
            this.attachments.metadata(actor, roomId, attachmentId),
          );
          return true;
        } catch (error: any) {
          if (["NOT_FOUND", "FORBIDDEN"].includes(error?.code)) return false;
          throw error;
        }
      };
      if (
        persona.avatarAttachmentId &&
        !authorized(persona.avatarAttachmentId)
      ) {
        delete persona.avatarAttachmentId;
        persona.avatar = "";
        persona.avatarType = "emoji";
      }
      if (persona.contextAttachmentIds)
        persona.contextAttachmentIds =
          persona.contextAttachmentIds.filter(authorized);
    }
    for (const current of page.slice(0, limit)) {
      this.policy.assert(actor, "EXPORT_DATA", { roomId });
      const versions = this.app.db
        .prepare(
          "SELECT * FROM message_revisions WHERE workspace_id=? AND room_id=? AND message_id=? ORDER BY revision LIMIT 1001",
        )
        .all(actor.workspaceId, roomId, current.message_id);
      if (versions.length > 1000)
        throw new OperationError("EXPORT_REVISION_LIMIT", 413);
      const revisions: any[] = [];
      for (const version of versions) {
        const rows = this.app.db
          .prepare(
            "SELECT * FROM message_segments WHERE workspace_id=? AND room_id=? AND message_id=? AND revision=? ORDER BY rowid",
          )
          .all(actor.workspaceId, roomId, current.message_id, version.revision);
        const segments = rows
          .filter((s) =>
            this.policy.canReadSegment(actor, {
              workspaceId: actor.workspaceId,
              roomId,
              ownerPersonaId: s.owner_persona_id
                ? String(s.owner_persona_id)
                : undefined,
              channel: String(s.channel),
              visibility: String(s.visibility),
            }),
          )
          .map((s) => ({
            id: s.segment_id,
            channel: s.channel,
            visibility: s.visibility,
            content: s.content,
            digest: s.digest,
            sourceRef: {
              workspaceId: actor.workspaceId,
              roomId,
              messageId: current.message_id,
              revisionId: version.revision_id,
              segmentId: s.segment_id,
            },
          }));
        if (!segments.length) continue;
        const links = this.app.db
          .prepare(
            "SELECT attachment_id FROM attachment_links WHERE workspace_id=? AND room_id=? AND message_id=? AND revision=?",
          )
          .all(actor.workspaceId, roomId, current.message_id, version.revision);
        const attachmentIds: string[] = [];
        for (const link of links) {
          const attachmentId = String(link.attachment_id);
          this.policy.assert(actor, "READ_ATTACHMENT", { roomId });
          const metadata = this.attachments.metadata(
            actor,
            roomId,
            attachmentId,
          );
          attachmentManifest.set(attachmentId, metadata);
          attachmentIds.push(attachmentId);
        }
        revisions.push({
          revision: version.revision,
          revisionId: version.revision_id,
          parentRevision: version.parent_revision,
          reason: version.reason,
          createdAt: version.created_at,
          segments,
          attachmentIds,
          visibleContentDigest: hash(json(segments)),
        });
      }
      if (revisions.length)
        messages.push({
          id: current.message_id,
          legacySources: this.legacySources(
            actor,
            String(current.message_id),
            "message",
          ),
          role: current.role,
          personaId: current.persona_id,
          currentRevision: current.current_revision,
          occurredAt: current.occurred_at,
          ingestedAt: current.ingested_at,
          modifiedAt: current.modified_at,
          revisions,
        });
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    // Legacy diagnostics have no trustworthy link to canonical generation receipts. Preserve as
    // historical events, scoped to a live persona; never emit their raw model/error strings.
    const decisions = this.app.db
      .prepare(
        `SELECT d.* FROM import_decisions d JOIN import_batches b ON b.workspace_id=d.workspace_id AND b.batch_id=d.batch_id
      JOIN personas p ON p.workspace_id=d.workspace_id AND p.persona_id=d.persona_id
      WHERE d.workspace_id=? AND d.room_id=? AND b.status='COMPLETE' AND p.deleted_at IS NULL ORDER BY d.rowid LIMIT 20001`,
      )
      .all(actor.workspaceId, roomId)
      .map((row) => {
        const value = JSON.parse(String(row.payload_json));
        return {
          id: row.decision_id,
          personaId: row.persona_id,
          legacyTurnId: row.legacy_turn_id,
          outcome: value.outcome,
          source: value.source,
          latencyMs: value.latencyMs,
          timestamp: value.timestamp,
          ...(value.reaction ? { reaction: value.reaction } : {}),
          legacy: true,
          legacySources: this.legacySources(
            actor,
            String(row.decision_id),
            "decision",
          ),
        };
      });
    if (decisions.length > 20000)
      throw new OperationError("EXPORT_DIAGNOSTIC_LIMIT", 413);
    const reactions = this.app.db
      .prepare(
        `SELECT r.reaction_id AS id,r.message_id AS messageId,r.persona_id AS personaId,r.legacy_turn_id AS legacyTurnId,r.semantic,r.occurred_at AS timestamp
      FROM import_reactions r JOIN import_batches b ON b.workspace_id=r.workspace_id AND b.batch_id=r.batch_id
      JOIN messages m ON m.workspace_id=r.workspace_id AND m.room_id=r.room_id AND m.message_id=r.message_id
      JOIN personas p ON p.workspace_id=r.workspace_id AND p.persona_id=r.persona_id
      WHERE r.workspace_id=? AND r.room_id=? AND b.status='COMPLETE' AND m.deleted_at IS NULL AND p.deleted_at IS NULL LIMIT 20001`,
      )
      .all(actor.workspaceId, roomId)
      .filter((row) => messages.some((m) => m.id === row.messageId))
      .map((row) => ({
        ...row,
        legacySources: this.legacySources(actor, String(row.id), "reaction"),
      }));
    if (reactions.length > 20000)
      throw new OperationError("EXPORT_DIAGNOSTIC_LIMIT", 413);
    const result = {
      schema: "MAP-DATA-1:EXPORT:1",
      workspaceId: actor.workspaceId,
      room,
      messages,
      attachments: [...attachmentManifest.values()],
      legacyDecisions: decisions,
      legacyReactions: reactions,
      generatedAt: Date.now(),
      nextCursor:
        page.length > limit
          ? this.cursor(actor, roomId, aclRevision, Number(page[limit - 1].seq))
          : null,
      deletionPolicy: "DELETED_CONTENT_EXCLUDED",
      confidentiality:
        "UNENCRYPTED_AUTHORIZED_CONTENT_KEEP_IN_PROTECTED_STORAGE",
    };
    if (Buffer.byteLength(json(result)) > 16 * 1024 * 1024)
      throw new OperationError("EXPORT_CHUNK_LIMIT", 413);
    // No await follows current policy, target-version and source checks. The returned object is
    // newly built; a denied or deleted source is never replaced with a cached result.
    this.policy.assert(actor, "EXPORT_DATA", { roomId });
    this.policy.assert(actor, "READ_CONVERSATION", { roomId });
    const currentRoom = this.repository.getRoom(actor, roomId);
    if (
      json(
        currentRoom.agents.map((p) => ({ id: p.id, revision: p.revision })),
      ) !==
        json(room.agents.map((p) => ({ id: p.id, revision: p.revision }))) ||
      json(currentRoom.historicalPersonas) !== json(room.historicalPersonas) ||
      currentRoom.revision !== room.revision ||
      this.app.db
        .prepare("SELECT acl_revision FROM workspaces WHERE workspace_id=?")
        .get(actor.workspaceId)?.acl_revision !== aclRevision
    )
      throw new OperationError("EXPORT_SOURCE_CHANGED", 409);
    for (const m of messages) {
      const current = this.app.db
        .prepare(
          "SELECT m.current_revision FROM messages m WHERE workspace_id=? AND room_id=? AND message_id=? AND deleted_at IS NULL AND (persona_id IS NULL OR EXISTS(SELECT 1 FROM personas p WHERE p.workspace_id=m.workspace_id AND p.persona_id=m.persona_id AND p.deleted_at IS NULL))",
        )
        .get(actor.workspaceId, roomId, m.id);
      if (current?.current_revision !== m.currentRevision)
        throw new OperationError("EXPORT_SOURCE_CHANGED", 409);
      for (const revision of m.revisions)
        for (const segment of revision.segments)
          if (
            !this.policy.canReadSegment(actor, {
              workspaceId: actor.workspaceId,
              roomId,
              ownerPersonaId: m.personaId,
              channel: segment.channel,
              visibility: segment.visibility,
            })
          )
            throw new OperationError("EXPORT_AUTHORIZATION_CHANGED", 409);
    }
    for (const attachmentId of attachmentManifest.keys())
      this.attachments.metadata(actor, roomId, attachmentId);
    return result;
  }
}
