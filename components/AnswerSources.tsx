import React, { useEffect, useRef, useState } from "react";
import type { MessageDTO } from "../shared/app-contracts";
import { answerSourceParts } from "../shared/context-citations";
import type { AnswerSourceDTO } from "../shared/context-citations";
import type { CitationResponse } from "../shared/search-contracts";
import { AppAPIError } from "../services/appClient";
import { openSearchCitation } from "../services/searchClient";

/** Mounted under the session/Room/answer revision key. No source is kept in browser storage. */
export default function AnswerSources({ roomId, message, onError }: {
  roomId: string;
  message: MessageDTO;
  onError: (error: unknown) => void;
}) {
  const context = message.context?.messageId === message.id &&
    message.context.revision === message.revision ? message.context : undefined;
  const sources = context?.supplied ?? [];
  const allowed = new Set(sources.map(source => source.alias));
  const sourceIdentity = JSON.stringify(sources);
  const [opened, setOpened] = useState<{ alias: string; value: CitationResponse }>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const request = useRef<AbortController>();
  useEffect(() => {
    setOpened(undefined);
    setError("");
    setBusy("");
    return () => request.current?.abort();
  }, [roomId, message.id, message.revision, context?.receiptId, sourceIdentity]);

  async function open(source: AnswerSourceDTO) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setOpened(undefined);
    setError("");
    setBusy(source.alias);
    try {
      const value = await openSearchCitation(roomId, source.citation, false, false, controller.signal);
      if (controller.signal.aborted || request.current !== controller) return;
      setOpened({ alias: source.alias, value });
    } catch (cause) {
      if (controller.signal.aborted || request.current !== controller) return;
      if (cause instanceof AppAPIError && cause.status === 401) onError(cause);
      setError("原文を表示できません。資料の版または閲覧権限が変更された可能性があります。");
    } finally {
      if (!controller.signal.aborted && request.current === controller) setBusy("");
    }
  }
  const sourceButton = (alias: string, key?: string | number) => (
    <button key={key} type="button" className="text-blue-300 underline underline-offset-2"
      aria-label={`参照元 ${alias} を開く`} disabled={!!busy}
      onClick={() => { const source = sources.find(item => item.alias === alias); if (source) void open(source); }}>
      [{alias}]
    </button>
  );
  return <>
    <p className="whitespace-pre-wrap break-words">
      {answerSourceParts(message.content || "(No public text)", allowed).map((part, index) =>
        part.alias ? sourceButton(part.alias, index) : <React.Fragment key={index}>{part.text}</React.Fragment>)}
    </p>
    {context && (context.mode !== "none" || context.state === "unavailable") && <div className="mt-3 border-t border-zinc-800 pt-2 text-xs text-zinc-400" aria-label="回答の参照資料">
      <p>{context.searches.map(search => search.target === "memory" ? (search.found ? "Memoryを参照" : "Memoryを検索") : "会話を検索").join(" · ")}
        {context.state !== "ready" && " · 一部の資料を確認できませんでした"}</p>
      {sources.length === 0 ? <p className="mt-1">資料で確認できませんでした。</p> : <>
        <p className="mt-1">回答に供給した資料: {sources.map((source, index) => <React.Fragment key={source.alias}>
          {index > 0 && " · "}{source.citation.target === "memory" ? "Memory" : "Archive"} {sourceButton(source.alias)}
        </React.Fragment>)}</p>
        <p className="mt-1">本文で引用: {context.citedAliases.length ? context.citedAliases.join(", ") : "なし"}</p>
        <p className="mt-1">引用記号の一致は、回答内容の正しさを保証するものではありません。</p>
      </>}
      {busy && <p role="status">原文を確認しています…</p>}
      {error && <p role="alert" className="text-amber-300 mt-2">{error}</p>}
      {opened && <div className="mt-2 rounded border border-zinc-700 p-3" aria-label={`参照元 ${opened.alias} の原文`}>
        <div className="flex justify-between gap-3">
          <span>原文 · {opened.alias} · {new Date(opened.value.recordedAt).toLocaleString()} · 版 {opened.value.citation.version}</span>
          <button type="button" onClick={() => setOpened(undefined)} aria-label="原文を閉じる">閉じる</button>
        </div>
        <p className="mt-2 whitespace-pre-wrap break-words text-zinc-200">{opened.value.text}</p>
      </div>}
    </div>}
  </>;
}
