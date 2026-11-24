import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AppError } from "../../shared/app-contracts/index.ts";

export type MemoryChangePosition = {
  mode: "baseline" | "delta";
  position: number;
  cutoff: number;
};

export function resyncRequired(): never {
  throw new AppError("MEMORY_RESYNC_REQUIRED", 409);
}

// Fixed-width ciphertext hides sequence numbers and activity in other scopes.
// The caller binds its current identity, room and authorization epoch as AAD.
export function sealChangeCursor(
  key: Buffer,
  context: Buffer,
  page: MemoryChangePosition,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(context);
  const data = Buffer.alloc(17);
  data[0] = page.mode === "baseline" ? 0 : 1;
  data.writeBigUInt64BE(BigInt(page.position), 1);
  data.writeBigUInt64BE(BigInt(page.cutoff), 9);
  return (
    "m1." +
    Buffer.concat([
      iv,
      cipher.update(data),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString("base64url")
  );
}

export function openChangeCursor(
  key: Buffer,
  context: Buffer,
  cursor: string,
): MemoryChangePosition {
  if (typeof cursor !== "string" || !/^m1\.[A-Za-z0-9_-]{60}$/.test(cursor))
    resyncRequired();
  try {
    const bytes = Buffer.from(cursor.slice(3), "base64url");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      bytes.subarray(0, 12),
    );
    decipher.setAAD(context);
    decipher.setAuthTag(bytes.subarray(29));
    const data = Buffer.concat([
      decipher.update(bytes.subarray(12, 29)),
      decipher.final(),
    ]);
    const position = Number(data.readBigUInt64BE(1)),
      cutoff = Number(data.readBigUInt64BE(9));
    if (
      data[0] > 1 ||
      !Number.isSafeInteger(position) ||
      !Number.isSafeInteger(cutoff) ||
      position > cutoff
    )
      resyncRequired();
    return { mode: data[0] === 0 ? "baseline" : "delta", position, cutoff };
  } catch {
    return resyncRequired();
  }
}
