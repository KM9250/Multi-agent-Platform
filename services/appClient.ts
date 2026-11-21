/** Browser-only BFF transport. Credentials and prompts never live in browser storage. */
export interface SessionDTO {
  actorId: string;
  workspaceId: string;
  csrfToken: string;
  models: string[];
  memoryLimits?: {
    maxCalls: number;
    maxHistory: number;
    maxTotalTokens: number;
  };
}
export type {
  AttachmentDTO,
  PersonaDTO,
  RoomDTO,
  MessageDTO,
} from "../shared/app-contracts";
export interface RunDTO {
  id: string;
  runId: string;
  turnId: string;
  roomId: string;
  inputMessageId: string;
  status: string;
  callCount: number;
  errorCode?: string;
  usage: Record<string, unknown>[];
  decisions: Record<string, unknown>[];
  reactions: Record<string, unknown>[];
  results: unknown[];
}
export class AppAPIError extends Error {
  constructor(
    public code: string,
    public status: number,
  ) {
    super(code);
    this.name = "AppAPIError";
  }
}
let csrfToken: string | undefined;
export function setSessionToken(session?: SessionDTO) {
  csrfToken = session?.csrfToken;
}
export async function appRequest<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/app/v1${path}`, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    signal,
    headers: {
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(method !== "GET" && csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AppAPIError("INVALID_SERVER_RESPONSE", response.status);
  }
  if (!response.ok) {
    const code = (payload as { error?: { code?: unknown } })?.error?.code;
    throw new AppAPIError(
      typeof code === "string" && /^[A-Z0-9_]{1,80}$/.test(code)
        ? code
        : "REQUEST_FAILED",
      response.status,
    );
  }
  return payload as T;
}
export const roomPath = (id: string) => `/rooms/${encodeURIComponent(id)}`;
export function authorizedAttachmentURL(
  roomId: string,
  attachment: { id: string; url?: string },
): string {
  // Construct from opaque IDs; never follow a URL supplied by imported content or a model.
  return `/api/app/v1/rooms/${encodeURIComponent(roomId)}/attachments/${encodeURIComponent(attachment.id)}/content`;
}
export async function fileToBase64(file: Blob): Promise<string> {
  if (file.size > 8 * 1024 * 1024)
    throw new AppAPIError("ATTACHMENT_TOO_LARGE", 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
export function downloadJSON(name: string, value: unknown): void {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
