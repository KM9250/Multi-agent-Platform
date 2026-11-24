import { AppError } from "../../shared/app-contracts/index.ts";
import { canonical } from "../app-data/validation.ts";

const KEYS = [
  "map_id",
  "map_operation",
  "kind",
  "assertion_type",
  "scope_hint",
  "source_refs",
  "recorded_at",
];
const invalid = () => new AppError("INVALID_MEMORY_MARKDOWN", 409);

function scalar(raw: string): string {
  if (raw.startsWith('"')) {
    let text: unknown;
    try {
      text = JSON.parse(raw);
    } catch {
      throw invalid();
    }
    if (
      typeof text === "string" &&
      text.length <= 1024 &&
      !/[\x00-\x1f]/.test(text)
    )
      return text;
  } else if (/^'[^\r\n]*'$/.test(raw)) {
    const quoted = raw.slice(1, -1);
    if (!quoted.replaceAll("''", "").includes("'"))
      return quoted.replaceAll("''", "'");
  } else if (/^[a-zA-Z0-9_][a-zA-Z0-9_:@#./+\-]{0,1023}$/.test(raw)) {
    return raw;
  }
  throw invalid();
}

/** Parse only MAP's flat, bounded Properties vocabulary. Content after the fence stays literal UTF-8. */
export function parseMemoryMarkdown(bytes: Buffer) {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalid();
  }
  if (text.includes("\0") || !text.startsWith("---")) throw invalid();
  const header = /^---\r?\n([\s\S]{1,16384}?)\r?\n---\r?\n/.exec(text);
  if (!header) throw invalid();
  const props: Record<string, string | string[]> = Object.create(null);
  let lastKey = "";
  for (const line of header[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (lastKey === "source_refs" && /^\s*- /.test(line)) {
      (props.source_refs as string[]).push(
        scalar(line.replace(/^\s*- /, "").trim()),
      );
      continue;
    }
    const field = /^([a-z_]+):(?: (.*))?$/.exec(line);
    if (!field || !KEYS.includes(field[1]) || field[1] in props)
      throw invalid();
    lastKey = field[1];
    const value = (field[2] ?? "").trim();
    if (lastKey !== "source_refs") {
      props[lastKey] = scalar(value);
      continue;
    }
    if (!value) {
      props.source_refs = [];
      continue;
    }
    let refs: unknown;
    try {
      refs = JSON.parse(value);
    } catch {
      throw invalid();
    }
    if (
      !Array.isArray(refs) ||
      !refs.every((v) => typeof v === "string" && v.length <= 1024)
    )
      throw invalid();
    props.source_refs = refs;
  }
  if (
    typeof props.map_id !== "string" ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(props.map_id) ||
    (props.map_operation !== undefined && !KEYS.every((key) => key in props)) ||
    (props.source_refs !== undefined &&
      (!Array.isArray(props.source_refs) || props.source_refs.length > 128))
  )
    throw invalid();
  return {
    noteId: props.map_id as string,
    operationId: props.map_operation as string | undefined,
    sourceRefs: (props.source_refs ?? []) as string[],
    scopeHint: props.scope_hint as string | undefined,
    kind: (props.kind ?? "unclassified") as string,
    assertionType: (props.assertion_type ?? "unclassified") as string,
    body: text.slice(header[0].length),
    metadata: canonical(props),
  };
}
