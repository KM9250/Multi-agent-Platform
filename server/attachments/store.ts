import {
  constants,
  createReadStream,
  existsSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import {
  open,
  rename,
  unlink,
  readdir,
  link,
  readFile,
  lstat,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  AppError,
  APP_LIMITS,
  type Actor,
  type AuthorizationPort,
  type AttachmentDTO,
} from "../../shared/app-contracts/index.ts";
import { AppDatabase, assertSafePath } from "../app-data/db.ts";
import { attachmentDTO } from "../app-data/repository.ts";
import {
  digest,
  id,
  object,
  string,
  securePolicy,
} from "../app-data/validation.ts";
type Row = Record<string, any>;
const TYPES = new Set([
  "text/plain",
  "text/markdown",
  "application/json",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
export interface AttachmentStoreOptions {
  hooks?: {
    afterStaging?: (id: string) => void;
    afterFileCommit?: (id: string) => void;
  };
}
export class AttachmentStore {
  readonly app: AppDatabase;
  readonly policy: AuthorizationPort;
  readonly options: AttachmentStoreOptions;
  constructor(
    app: AppDatabase,
    policy: AuthorizationPort,
    options: AttachmentStoreOptions = {},
  ) {
    this.app = app;
    this.policy = securePolicy(policy);
    this.options = options;
  }
  #path(directory: "attachments" | "staging", key: string): string {
    if (!/^[a-f0-9-]{36}$/.test(key)) throw new AppError("INVALID_ATTACHMENT");
    const path = join(this.app.root, directory, key);
    assertSafePath(this.app.root, "directory");
    assertSafePath(join(this.app.root, directory), "directory");
    assertSafePath(path, "file");
    if (
      realpathSync(join(this.app.root, directory)) !==
      join(this.app.root, directory)
    )
      throw new AppError("UNSAFE_PATH");
    return path;
  }
  async #uploadDestination(key: string): Promise<string> {
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        return this.#path("attachments", key);
      } catch (error) {
        const destination = join(this.app.root, "attachments", key);
        let pending = false;
        try {
          const current = await lstat(destination);
          if (
            current.isFile() &&
            !current.isSymbolicLink() &&
            current.nlink === 1
          )
            pending = true;
          if (
            current.isFile() &&
            !current.isSymbolicLink() &&
            current.nlink === 2
          ) {
            const staging = await readdir(join(this.app.root, "staging"));
            for (const entry of staging) {
              if (!/^[a-f0-9-]{36}$/.test(entry)) continue;
              const path = join(this.app.root, "staging", entry),
                candidate = await lstat(path).catch(() => null);
              if (
                candidate?.isFile() &&
                !candidate.isSymbolicLink() &&
                candidate.dev === current.dev &&
                candidate.ino === current.ino &&
                candidate.nlink === 2
              ) {
                pending = true;
                break;
              }
            }
          }
          if (!pending) {
            const final = await lstat(destination);
            if (final.isFile() && !final.isSymbolicLink() && final.nlink === 1)
              pending = true;
          }
        } catch {}
        if (!pending) throw error;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    throw new AppError("ATTACHMENT_IN_PROGRESS", 409);
  }
  #room(actor: Actor, roomId: string, allowImport = false): void {
    const room = this.app.db
      .prepare(
        "SELECT import_batch_id FROM rooms WHERE workspace_id=? AND room_id=? AND deleted_at IS NULL",
      )
      .get(actor.workspaceId, roomId);
    if (!room) throw new AppError("NOT_FOUND", 404);
    if (
      room.import_batch_id &&
      !this.app.db
        .prepare(
          "SELECT 1 FROM import_batches WHERE workspace_id=? AND batch_id=? AND status='COMPLETE'",
        )
        .get(actor.workspaceId, room.import_batch_id)
    ) {
      if (!allowImport) throw new AppError("NOT_FOUND", 404);
      this.policy.assert(actor, "IMPORT_DATA", { roomId });
    }
  }
  #row(actor: Actor, roomId: string, attachmentId: string): Row {
    const row = this.app.db
      .prepare(
        "SELECT * FROM attachments WHERE workspace_id=? AND room_id=? AND attachment_id=? AND state='AVAILABLE' AND deleted_at IS NULL",
      )
      .get(actor.workspaceId, roomId, attachmentId) as Row | undefined;
    if (!row) throw new AppError("NOT_FOUND", 404);
    return row;
  }
  #authorized(
    actor: Actor,
    roomId: string,
    row: Row,
    contextPersonaId?: string,
    importBatchId?: string,
  ): void {
    if (importBatchId) {
      this.policy.assert(actor, "IMPORT_DATA", { roomId });
      const owned = this.app.db
        .prepare(
          "SELECT 1 FROM import_batches b JOIN rooms r ON r.workspace_id=b.workspace_id AND r.import_batch_id=b.batch_id WHERE b.workspace_id=? AND b.batch_id=? AND b.actor_id=? AND r.room_id=?",
        )
        .get(actor.workspaceId, importBatchId, actor.actorId, roomId);
      if (!owned || row.owner_actor_id !== actor.actorId)
        throw new AppError("NOT_FOUND", 404);
      return;
    }
    this.policy.assert(
      actor,
      contextPersonaId ? "GENERATE" : "READ_ATTACHMENT",
      { roomId, personaId: contextPersonaId },
    );
    this.#room(actor, roomId);
    if (contextPersonaId) {
      const link = this.app.db
        .prepare(
          "SELECT 1 FROM persona_attachment_links l JOIN room_personas rp USING(workspace_id,room_id,persona_id) JOIN personas p USING(workspace_id,persona_id) WHERE l.workspace_id=? AND l.room_id=? AND l.attachment_id=? AND l.persona_id=? AND l.persona_revision=rp.persona_revision AND l.purpose='CONTEXT' AND p.deleted_at IS NULL",
        )
        .get(actor.workspaceId, roomId, row.attachment_id, contextPersonaId);
      if (!link) throw new AppError("NOT_FOUND", 404);
      return;
    }
    const publicMessage = this.app.db
      .prepare(
        "SELECT 1 FROM attachment_links l JOIN messages m USING(workspace_id,room_id,message_id) WHERE l.workspace_id=? AND l.room_id=? AND l.attachment_id=? AND m.deleted_at IS NULL AND (m.persona_id IS NULL OR EXISTS(SELECT 1 FROM personas p WHERE p.workspace_id=m.workspace_id AND p.persona_id=m.persona_id AND p.deleted_at IS NULL)) AND EXISTS(SELECT 1 FROM message_segments s WHERE s.workspace_id=m.workspace_id AND s.room_id=m.room_id AND s.message_id=m.message_id AND s.revision=l.revision AND s.visibility='public') LIMIT 1",
      )
      .get(actor.workspaceId, roomId, row.attachment_id);
    if (publicMessage) return;
    const privateSegments = this.app.db
      .prepare(
        "SELECT DISTINCT s.owner_persona_id,s.channel,s.visibility FROM attachment_links l JOIN messages m USING(workspace_id,room_id,message_id) JOIN message_segments s ON s.workspace_id=l.workspace_id AND s.room_id=l.room_id AND s.message_id=l.message_id AND s.revision=l.revision WHERE l.workspace_id=? AND l.room_id=? AND l.attachment_id=? AND m.deleted_at IS NULL AND s.visibility<>'public' AND (m.persona_id IS NULL OR EXISTS(SELECT 1 FROM personas p WHERE p.workspace_id=m.workspace_id AND p.persona_id=m.persona_id AND p.deleted_at IS NULL)) LIMIT 500",
      )
      .all(actor.workspaceId, roomId, row.attachment_id) as Row[];
    if (
      privateSegments.some((segment) =>
        this.policy.canReadSegment(actor, {
          workspaceId: actor.workspaceId,
          roomId,
          ownerPersonaId: segment.owner_persona_id ?? undefined,
          channel: segment.channel,
          visibility: segment.visibility,
        }),
      )
    )
      return;
    const personaLinks = this.app.db
      .prepare(
        "SELECT l.persona_id,l.purpose FROM persona_attachment_links l JOIN room_personas rp USING(workspace_id,room_id,persona_id) JOIN personas p USING(workspace_id,persona_id) WHERE l.workspace_id=? AND l.room_id=? AND l.attachment_id=? AND l.persona_revision=rp.persona_revision AND p.deleted_at IS NULL",
      )
      .all(actor.workspaceId, roomId, row.attachment_id) as Row[];
    if (personaLinks.some((l) => l.purpose === "AVATAR")) return;
    for (const link of personaLinks) {
      try {
        this.policy.assert(actor, "EDIT_PERSONA", {
          roomId,
          personaId: link.persona_id,
        });
        return;
      } catch {}
    }
    // An author can inspect staged uploads. Once referenced, deletion/classification applies even to the author.
    const linked = this.app.db
      .prepare(
        "SELECT 1 FROM attachment_links WHERE workspace_id=? AND room_id=? AND attachment_id=? UNION ALL SELECT 1 FROM persona_attachment_links WHERE workspace_id=? AND room_id=? AND attachment_id=? LIMIT 1",
      )
      .get(
        actor.workspaceId,
        roomId,
        row.attachment_id,
        actor.workspaceId,
        roomId,
        row.attachment_id,
      );
    if (!linked && row.owner_actor_id === actor.actorId) return;
    throw new AppError("NOT_FOUND", 404);
  }
  async upload(
    actor: Actor,
    roomId: string,
    input: { name: string; mimeType: string; data: Buffer | Uint8Array },
    options: { attachmentId?: string } = {},
  ): Promise<AttachmentDTO> {
    this.policy.assert(actor, "UPLOAD_ATTACHMENT", { roomId });
    this.#room(actor, roomId, true);
    if (
      !input ||
      typeof input !== "object" ||
      Object.getPrototypeOf(input) !== Object.prototype ||
      Object.keys(input).some((k) => !["name", "mimeType", "data"].includes(k))
    )
      throw new AppError("INVALID_INPUT");
    const name = string(input.name, 200),
      mimeType = string(input.mimeType, 100);
    if (!TYPES.has(mimeType)) throw new AppError("UNSUPPORTED_MEDIA_TYPE", 415);
    if (!(input.data instanceof Uint8Array))
      throw new AppError("INVALID_INPUT");
    const data = Buffer.from(input.data);
    if (data.length > APP_LIMITS.attachmentBytes)
      throw new AppError("ATTACHMENT_TOO_LARGE", 413);
    this.#validateMime(mimeType, data);
    const attachmentId = options.attachmentId ?? id(),
      key = options.attachmentId ?? id(),
      stagingKey = id(),
      staging = this.#path("staging", stagingKey),
      destination = await this.#uploadDestination(key);
    const prior = this.app.db
      .prepare(
        "SELECT * FROM attachments WHERE workspace_id=? AND room_id=? AND attachment_id=?",
      )
      .get(actor.workspaceId, roomId, attachmentId) as Row | undefined;
    if (prior) {
      if (
        prior.owner_actor_id !== actor.actorId ||
        prior.name !== name ||
        prior.mime_type !== mimeType ||
        prior.digest !== digest(data) ||
        prior.state !== "AVAILABLE"
      )
        throw new AppError("ATTACHMENT_CONFLICT", 409);
      return attachmentDTO(prior);
    }
    let file = await open(
      staging,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    this.options.hooks?.afterStaging?.(attachmentId);
    this.#path("staging", stagingKey);
    await this.#uploadDestination(key);
    try {
      await link(staging, destination);
    } catch (e) {
      if ((e as any).code !== "EEXIST") throw e;
      const check = await this.#uploadDestination(key);
      const existing = await readFile(check);
      if (digest(existing) !== digest(data))
        throw new AppError("ATTACHMENT_CONFLICT", 409);
    }
    await unlink(staging);
    const directory = await open(
      join(this.app.root, "attachments"),
      constants.O_RDONLY,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    this.options.hooks?.afterFileCommit?.(attachmentId);
    return this.app.transaction(() => {
      this.policy.assert(actor, "UPLOAD_ATTACHMENT", { roomId });
      this.#room(actor, roomId, true);
      const now = Date.now(),
        hash = digest(data);
      const duplicate = this.app.db
        .prepare(
          "SELECT * FROM attachments WHERE workspace_id=? AND room_id=? AND attachment_id=?",
        )
        .get(actor.workspaceId, roomId, attachmentId) as Row | undefined;
      if (duplicate) {
        if (
          duplicate.owner_actor_id !== actor.actorId ||
          duplicate.name !== name ||
          duplicate.mime_type !== mimeType ||
          duplicate.digest !== hash ||
          duplicate.state !== "AVAILABLE"
        )
          throw new AppError("ATTACHMENT_CONFLICT", 409);
        return attachmentDTO(duplicate);
      }
      this.app.db
        .prepare(
          "INSERT INTO attachments VALUES(?,?,?,?,?,?,?,?,?,'AVAILABLE',?,NULL)",
        )
        .run(
          actor.workspaceId,
          roomId,
          attachmentId,
          actor.actorId,
          name,
          mimeType,
          key,
          hash,
          data.length,
          now,
        );
      this.app.audit(
        actor.actorId,
        actor.workspaceId,
        "UPLOAD_ATTACHMENT",
        attachmentId,
      );
      return {
        id: attachmentId,
        name,
        mimeType,
        size: data.length,
        digest: hash,
        url: `/api/app/v1/rooms/${encodeURIComponent(roomId)}/attachments/${attachmentId}/content`,
      };
    }, "attachment_commit");
  }
  #validateMime(type: string, data: Buffer): void {
    let valid = true;
    if (type === "image/png")
      valid = data
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (type === "image/jpeg")
      valid =
        data.length >= 4 &&
        data[0] === 255 &&
        data[1] === 216 &&
        data[2] === 255;
    if (type === "image/gif")
      valid = ["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString());
    if (type === "image/webp")
      valid =
        data.subarray(0, 4).toString() === "RIFF" &&
        data.subarray(8, 12).toString() === "WEBP";
    if (type.startsWith("text/") || type === "application/json") {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(data);
      } catch {
        valid = false;
      }
    }
    if (!valid) throw new AppError("MIME_MISMATCH", 415);
  }
  metadata(actor: Actor, roomId: string, attachmentId: string): AttachmentDTO {
    const row = this.#row(actor, roomId, attachmentId);
    this.#authorized(actor, roomId, row);
    return attachmentDTO(row);
  }
  async #read(
    actor: Actor,
    roomId: string,
    attachmentId: string,
    personaId?: string,
    importBatchId?: string,
  ): Promise<{ metadata: AttachmentDTO; data: Buffer }> {
    const row = this.#row(actor, roomId, attachmentId);
    this.#authorized(actor, roomId, row, personaId, importBatchId);
    const path = this.#path("attachments", row.blob_key);
    let file;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const st = await file.stat();
      if (
        !st.isFile() ||
        st.nlink !== 1 ||
        st.size !== row.size ||
        st.size > APP_LIMITS.attachmentBytes
      )
        throw new AppError("ATTACHMENT_INTEGRITY", 409);
      const data = await file.readFile();
      if (digest(data) !== row.digest)
        throw new AppError("ATTACHMENT_INTEGRITY", 409);
      this.#authorized(actor, roomId, row, personaId, importBatchId);
      const current = this.#row(actor, roomId, attachmentId);
      if (current.digest !== row.digest)
        throw new AppError("ATTACHMENT_INTEGRITY", 409);
      return { metadata: attachmentDTO(row), data };
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError("ATTACHMENT_MISSING", 409);
    } finally {
      await file?.close();
    }
  }
  read(actor: Actor, roomId: string, attachmentId: string) {
    return this.#read(actor, roomId, attachmentId);
  }
  readForImport(
    actor: Actor,
    roomId: string,
    attachmentId: string,
    batchId: string,
  ) {
    return this.#read(actor, roomId, attachmentId, undefined, batchId);
  }
  readForContext(
    actor: Actor,
    roomId: string,
    attachmentId: string,
    personaId: string,
  ) {
    return this.#read(actor, roomId, attachmentId, personaId);
  }
  delete(actor: Actor, roomId: string, attachmentId: string): void {
    this.policy.assert(actor, "UPLOAD_ATTACHMENT", { roomId });
    this.#room(actor, roomId);
    const row = this.#row(actor, roomId, attachmentId);
    if (row.owner_actor_id !== actor.actorId)
      throw new AppError("NOT_FOUND", 404);
    this.app.transaction(() => {
      this.app.db
        .prepare(
          "UPDATE attachments SET state='DELETED',deleted_at=? WHERE workspace_id=? AND room_id=? AND attachment_id=?",
        )
        .run(Date.now(), actor.workspaceId, roomId, attachmentId);
      this.app.audit(
        actor.actorId,
        actor.workspaceId,
        "DELETE_ATTACHMENT",
        attachmentId,
      );
      this.app.change(
        actor.workspaceId,
        roomId,
        "ATTACHMENT",
        attachmentId,
        null,
        "DELETE",
      );
    });
  }
  /** Host maintenance only. Default is report; removal requires explicit invocation and preserves every referenced blob. */
  async collectOrphans(
    remove = false,
  ): Promise<{ staging: string[]; orphans: string[] }> {
    const staging = await readdir(join(this.app.root, "staging")),
      files = await readdir(join(this.app.root, "attachments"));
    const referenced = new Set(
      this.app.db
        .prepare("SELECT blob_key FROM attachments")
        .all()
        .map((r) => r.blob_key),
    );
    const orphans = files.filter((f) => !referenced.has(f));
    if (remove) {
      for (const [directory, entries] of [
        ["staging", staging],
        ["attachments", orphans],
      ] as const)
        for (const key of entries) {
          const path = this.#path(directory, key);
          if (lstatSync(path).nlink !== 1) throw new AppError("UNSAFE_PATH");
          await unlink(path);
        }
    }
    return { staging, orphans };
  }
}
