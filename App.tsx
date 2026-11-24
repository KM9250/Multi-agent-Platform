import React, { useEffect, useRef, useState } from "react";
import {
  Menu,
  Send,
  Paperclip,
  Settings,
  X,
  LogOut,
  RefreshCw,
} from "lucide-react";
import MemoryPanel from "./components/MemoryPanel";
import SearchPanel from "./components/SearchPanel";
import AgentSidebar from "./components/AgentSidebar";
import AgentModal from "./components/AgentModal";
import RoomModal from "./components/RoomModal";
import RelationshipGraphModal from "./components/RelationshipGraphModal";
import {
  DataDialog,
  LoginPanel,
  MigrationPanel,
} from "./components/AppDataPanels";
import {
  AppAPIError,
  appRequest,
  authorizedAttachmentURL,
  downloadJSON,
  fileToBase64,
  roomPath,
  setSessionToken,
  type SessionDTO,
  type RoomDTO,
  type PersonaDTO,
  type MessageDTO,
  type AttachmentDTO,
  type RunDTO,
} from "./services/appClient";
import {
  createRecipientSnapshot,
  type RecipientSelection,
} from "./utils/recipientTargets";
import type { Agent, Room, RoomTag, InternalStateSettings } from "./types";

const stateLabels: Record<string, string> = {
  QUEUED: "Server accepted",
  RUNNING: "Generating",
  COMPLETED: "Result saved",
  PARTIAL: "Partially saved",
  FAILED: "Generation failed",
  CANCELLED: "Cancelled",
  NEEDS_REVIEW: "Outcome unknown · review required",
};
const generationErrorText = (code: string) =>
  code === "HISTORY_WINDOW_PIN_CONFLICT"
    ? "履歴を2件以上にするか、最初の発言固定を解除してください。"
    : code;
const reactionEmoji: Record<string, string> = {
  ACK: "👍",
  AGREE: "✅",
  THINK: "🤔",
  AMUSED: "😂",
  CARE: "❤️",
  DISAGREE: "👎",
};
const busyRun = (run: RunDTO) =>
  run.status === "QUEUED" || run.status === "RUNNING";
const list = <T,>(value: T[] | { [key: string]: T[] }, key: string): T[] =>
  Array.isArray(value) ? value : (value[key] ?? []);
function displayAgent(persona: PersonaDTO, roomId: string): Agent {
  return {
    id: persona.id,
    name: persona.name,
    description: persona.description ?? "",
    systemInstruction: persona.systemInstruction ?? "",
    model: persona.model,
    framework: (persona.framework as Agent["framework"]) ?? "standard",
    color: typeof persona.color === "string" ? persona.color : "bg-blue-600",
    avatar: persona.avatarAttachmentId
      ? authorizedAttachmentURL(roomId, { id: persona.avatarAttachmentId })
      : persona.avatarType !== "image" && typeof persona.avatar === "string"
        ? persona.avatar.slice(0, 64)
        : "🤖",
    avatarType: persona.avatarAttachmentId ? "image" : "emoji",
    isEnabled: persona.isEnabled !== false,
    thinkingBudget: Number(persona.thinkingBudget ?? 0),
    historyWindow: Number(persona.historyWindow ?? 0),
    pinFirstMessage: persona.pinFirstMessage !== false,
    groups: (persona.groups as string[]) ?? [],
    participationProfile: (persona.participationProfile as string) ?? "",
    subAgents: (persona.subAgents as Agent["subAgents"]) ?? [],
    subAgentPolicy: (persona.subAgentPolicy as Agent["subAgentPolicy"]) ?? {
      mode: "off",
    },
    additionalContextFiles: [],
    importedSystemInstruction: persona.importedSystemInstruction,
    importedSystemInstructionFileName:
      persona.importedSystemInstructionFileName,
  };
}
function displayRoom(room: RoomDTO, messages: MessageDTO[] = []): Room {
  return {
    ...room,
    agents: room.agents.map((persona) => displayAgent(persona, room.id)),
    messages: messages.map((message) => ({
      ...message,
      attachments: undefined,
      segments: undefined,
    })),
  };
}

export default function App() {
  const [session, setSession] = useState<SessionDTO | null>();
  const [rooms, setRooms] = useState<RoomDTO[]>([]);
  const [scopeVersion, setScopeVersion] = useState(0);
  const [roomId, setRoomId] = useState("");
  const [room, setRoom] = useState<RoomDTO>();
  const [messages, setMessages] = useState<MessageDTO[]>([]);
  const [pageAfter, setPageAfter] = useState<string>();
  const afterRef = useRef<string>();
  const [cursor, setCursor] = useState<string>();
  const [runs, setRuns] = useState<RunDTO[]>([]);
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [recipient, setRecipient] = useState<RecipientSelection>("auto");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState(false);
  const [roomEditSnapshot, setRoomEditSnapshot] = useState<
    Room & { revision: number }
  >();
  const [sidebar, setSidebar] = useState(false);
  const [roomEditor, setRoomEditor] = useState<"new" | "edit">();
  const [agentEditor, setAgentEditor] = useState<Agent | null | undefined>();
  const personaEditRevision = useRef<number>();
  const [savedContexts, setSavedContexts] = useState<
    { id: string; name: string; url: string }[]
  >([]);
  const [exportState, setExportState] = useState<{
    roomId: string;
    nextCursor?: string;
    part: number;
    complete: boolean;
  }>();
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [migration, setMigration] = useState(false);
  const [graph, setGraph] = useState(false);
  const [reader, setReader] = useState<{ title: string; data: unknown }>();
  const [correction, setCorrection] = useState<{
    message: MessageDTO;
    content: string;
  }>();
  const epoch = useRef(0);
  const selected = useRef("");
  const sessionRef = useRef<SessionDTO | null>(null);
  const sessionChanges = useRef<BroadcastChannel>();
  const pendingTurn = useRef<{ roomId: string; path: string; body: unknown }>();
  const fileInput = useRef<HTMLInputElement>(null);
  const agents =
    room?.agents.map((persona) => displayAgent(persona, room.id)) ?? [];
  const enabledPersonas = agents.filter((agent) => agent.isEnabled);
  const memoryCommand =
    room?.internalStateSettings.enabled && input.trim() === "/memory";
  const speakerName = (personaId?: string) => {
    const current = agents.find((agent) => agent.id === personaId);
    const historical = room?.historicalPersonas?.find(
      (persona) => persona.id === personaId,
    );
    return (
      current?.name ??
      (historical
        ? `Deleted Persona (${historical.legacyPersonaId})`
        : "Persona")
    );
  };
  const groups = [...new Set(agents.flatMap((agent) => agent.groups ?? []))];
  const reactions = [
    ...runs.flatMap((run) => run.reactions ?? []),
    ...(room?.legacyReactions ?? []),
  ];

  function clearIdentity() {
    epoch.current++;
    sessionRef.current = null;
    setSessionToken();
    setSession(null);
    setRooms([]);
    selected.current = "";
    setRoomId("");
    setRoom(undefined);
    setMessages([]);
    setRuns([]);
    setCursor(undefined);
    afterRef.current = undefined;
    setPageAfter(undefined);
    setInput("");
    setFiles([]);
    setReader(undefined);
    setMemoryOpen(false);
    setSearchOpen(false);
    setCorrection(undefined);
    pendingTurn.current = undefined;
    setPending(false);
    setSending(false);
    setAgentEditor(undefined);
    setRoomEditor(undefined);
    setRoomEditSnapshot(undefined);
    setSavedContexts([]);
    personaEditRevision.current = undefined;
    setMigration(false);
    setGraph(false);
    setExportState(undefined);
    setNotice("");
  }
  function fail(cause: unknown) {
    if (cause instanceof DOMException && cause.name === "AbortError") return;
    const code =
      cause instanceof AppAPIError ? cause.code : "CONNECTION_FAILED";
    if (cause instanceof AppAPIError && cause.status === 401) clearIdentity();
    else if (cause instanceof AppAPIError && cause.status === 403) {
      epoch.current++;
      setRoom(undefined);
      setMessages([]);
      setRuns([]);
      setReader(undefined);
      setMemoryOpen(false);
      setSearchOpen(false);
      setCorrection(undefined);
    }
    setError(code);
  }
  function signIn(value: SessionDTO) {
    clearIdentity();
    sessionRef.current = value;
    setSessionToken(value);
    setSession(value);
    setError("");
  }
  async function loadRooms() {
    const ticket = epoch.current;
    const value = await appRequest<RoomDTO[] | { rooms: RoomDTO[] }>("/rooms");
    if (ticket !== epoch.current || !sessionRef.current) return;
    const values = list(value, "rooms");
    setRooms(values);
    if (
      !selected.current ||
      !values.some((item) => item.id === selected.current)
    ) {
      selected.current = values[0]?.id ?? "";
      setRoomId(selected.current);
    }
  }
  async function refresh(id: string, ticket: number, signal?: AbortSignal) {
    const after = afterRef.current;
    const [nextRoom, page, nextRuns] = await Promise.all([
      appRequest<RoomDTO>(roomPath(id), "GET", undefined, signal),
      appRequest<{ messages: MessageDTO[]; cursor?: string }>(
        `${roomPath(id)}/messages?limit=50${after ? `&cursor=${encodeURIComponent(after)}` : ""}`,
        "GET",
        undefined,
        signal,
      ),
      appRequest<RunDTO[] | { generations: RunDTO[] }>(
        `${roomPath(id)}/generations`,
        "GET",
        undefined,
        signal,
      ),
    ]);
    if (
      ticket !== epoch.current ||
      selected.current !== id ||
      !sessionRef.current ||
      after !== afterRef.current
    )
      return;
    setRoom(nextRoom);
    setMessages(page.messages);
    setCursor(page.cursor);
    setRuns(list(nextRuns, "generations"));
    setRooms((current) =>
      current.map((item) => (item.id === id ? nextRoom : item)),
    );
  }
  function switchRoom(id: string) {
    epoch.current++;
    setScopeVersion((value) => value + 1);
    selected.current = id;
    setRoomId(id);
    setRoom(undefined);
    setMessages([]);
    setRuns([]);
    setCursor(undefined);
    afterRef.current = undefined;
    setPageAfter(undefined);
    setInput("");
    setFiles([]);
    setReader(undefined);
    setMemoryOpen(false);
    setSearchOpen(false);
    setCorrection(undefined);
    setExportState(undefined);
    setRoomEditSnapshot(undefined);
    setSavedContexts([]);
    personaEditRevision.current = undefined;
    setAgentEditor(undefined);
    setRoomEditor(undefined);
    setRecipient("auto");
    setNotice("");
    setError("");
    setSidebar(false);
    pendingTurn.current = undefined;
    setPending(false);
    setSending(false);
  }
  useEffect(() => {
    let controller: AbortController;
    function readSession() {
      controller?.abort();
      controller = new AbortController();
      const { signal } = controller;
      const ticket = epoch.current;
      appRequest<SessionDTO>("/session", "GET", undefined, signal)
        .then((value) => {
          if (!signal.aborted && epoch.current === ticket) signIn(value);
        })
        .catch((cause) => {
          if (signal.aborted || epoch.current !== ticket) return;
          clearIdentity();
          if (!(cause instanceof AppAPIError && cause.status === 401))
            fail(cause);
        });
    }
    function identityChanged() {
      clearIdentity();
      readSession();
    }
    // All tabs on this origin share the session cookie. Send only the change
    // notification; each tab obtains its new identity directly from the BFF.
    const channel =
      typeof BroadcastChannel === "undefined"
        ? undefined
        : new BroadcastChannel("map-session");
    if (channel) channel.onmessage = identityChanged;
    sessionChanges.current = channel;
    const restoredPage = (event: PageTransitionEvent) => {
      if (event.persisted) identityChanged();
    };
    window.addEventListener("pageshow", restoredPage);
    readSession();
    return () => {
      controller.abort();
      window.removeEventListener("pageshow", restoredPage);
      channel?.close();
      sessionChanges.current = undefined;
    };
  }, []);
  useEffect(() => {
    if (session) void loadRooms().catch(fail);
  }, [session?.actorId]);
  useEffect(() => {
    if (!session || !roomId) return;
    const controller = new AbortController();
    const ticket = epoch.current;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await refresh(roomId, ticket, controller.signal);
      } catch (cause) {
        if (!controller.signal.aborted && ticket === epoch.current) fail(cause);
      }
      if (!controller.signal.aborted && ticket === epoch.current)
        timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [session?.actorId, roomId, pageAfter, scopeVersion]);

  async function logout() {
    setSearchOpen(false);
    try {
      await appRequest("/session/logout", "POST", {});
      sessionChanges.current?.postMessage("changed");
      clearIdentity();
      setError("");
    } catch (cause) {
      fail(cause);
      setNotice(
        "Logout was not confirmed by the server. Retry when connected.",
      );
    }
  }
  async function saveRoom(
    title: string,
    description: string,
    type: RoomTag,
    systemInstruction: string,
    internalStateSettings: InternalStateSettings,
  ) {
    const ticket = epoch.current;
    try {
      const value = await appRequest<RoomDTO>(
        roomEditor === "edit" && room ? roomPath(room.id) : "/rooms",
        roomEditor === "edit" ? "PATCH" : "POST",
        {
          title,
          description,
          type,
          systemInstruction,
          internalStateSettings,
          ...(roomEditor === "edit"
            ? { expectedRevision: roomEditSnapshot?.revision }
            : {}),
        },
      );
      if (ticket !== epoch.current) return false;
      await loadRooms();
      switchRoom(value.id);
      setRoomEditor(undefined);
      return true;
    } catch (cause) {
      fail(cause);
      return false;
    }
  }
  async function upload(
    roomId: string,
    file: Blob,
    name: string,
    mimeType: string,
  ) {
    return appRequest<AttachmentDTO>(
      `${roomPath(roomId)}/attachments`,
      "POST",
      { name, mimeType, data: await fileToBase64(file) },
    );
  }
  async function saveAgent(agent: Agent) {
    if (!room) return false;
    const id = room.id;
    const ticket = epoch.current;
    const previous = room.agents.find((item) => item.id === agent.id);
    try {
      let avatarAttachmentId = previous?.avatarAttachmentId;
      if (
        agent.avatarType === "image" &&
        agent.avatar.startsWith("data:image/")
      ) {
        const match =
          /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(
            agent.avatar,
          );
        if (!match) throw new AppAPIError("INVALID_AVATAR", 400);
        const result = await appRequest<AttachmentDTO>(
          `${roomPath(id)}/attachments`,
          "POST",
          { name: "avatar", mimeType: match[1], data: match[2] },
        );
        avatarAttachmentId = result.id;
      }
      if (agent.avatarType !== "image") avatarAttachmentId = undefined;
      const contextAttachmentIds = previous
        ? savedContexts.map((item) => item.id)
        : [];
      for (const file of agent.additionalContextFiles ?? []) {
        if (ticket !== epoch.current) return false;
        const attachment = await upload(
          id,
          new Blob([file.content]),
          file.name,
          "text/plain",
        );
        contextAttachmentIds.push(attachment.id);
      }
      if (ticket !== epoch.current) return false;
      const {
        id: _id,
        additionalContextFiles: _files,
        avatar: _avatar,
        ...settings
      } = agent;
      const body = {
        ...settings,
        avatar: agent.avatarType === "image" ? "" : agent.avatar,
        ...(avatarAttachmentId ? { avatarAttachmentId } : {}),
        contextAttachmentIds,
        ...(previous ? { expectedRevision: personaEditRevision.current } : {}),
      };
      await appRequest(
        `${roomPath(id)}/personas${previous ? `/${encodeURIComponent(previous.id)}` : ""}`,
        previous ? "PATCH" : "POST",
        body,
      );
      await refresh(id, ticket);
      return true;
    } catch (cause) {
      fail(cause);
      return false;
    }
  }
  async function toggleAgent(id: string) {
    const persona = room?.agents.find((item) => item.id === id);
    if (!persona || !room) return;
    try {
      await appRequest(
        `${roomPath(room.id)}/personas/${encodeURIComponent(id)}`,
        "PATCH",
        { expectedRevision: persona.revision, isEnabled: !persona.isEnabled },
      );
      await refresh(room.id, epoch.current);
    } catch (cause) {
      fail(cause);
    }
  }
  async function remove(kind: "room" | "persona" | "message", id: string) {
    const targetRoom =
      kind === "room" ? rooms.find((item) => item.id === id) : room;
    if (
      !targetRoom ||
      !window.confirm(
        `Delete this ${kind}? It will be removed from current views and future context.`,
      )
    )
      return;
    const revision =
      kind === "room"
        ? targetRoom.revision
        : kind === "persona"
          ? targetRoom.agents.find((item) => item.id === id)?.revision
          : messages.find((item) => item.id === id)?.revision;
    try {
      await appRequest(
        `${roomPath(targetRoom.id)}${kind === "room" ? "" : `/${kind === "persona" ? "personas" : "messages"}/${encodeURIComponent(id)}`}`,
        "DELETE",
        { expectedRevision: revision },
      );
      if (kind === "room") {
        switchRoom("");
        await loadRooms();
      } else await refresh(targetRoom.id, epoch.current);
    } catch (cause) {
      fail(cause);
    }
  }
  async function send(retry = false) {
    if (!room || sending || (!retry && !input.trim() && files.length === 0))
      return;
    const id = room.id;
    const ticket = epoch.current;
    setSending(true);
    setError("");
    setNotice("Not sent");
    try {
      if (!pendingTurn.current) {
        const attachmentIds: string[] = [];
        for (const file of files) {
          if (ticket !== epoch.current) return;
          const attachment = await upload(
            id,
            file,
            file.name,
            file.type || "text/plain",
          );
          attachmentIds.push(attachment.id);
        }
        if (ticket !== epoch.current) return;
        pendingTurn.current = {
          roomId: id,
          path: `${roomPath(id)}/turns`,
          body: {
            requestId: crypto.randomUUID(),
            expectedRoomRevision: room.revision,
            content: input,
            attachmentIds,
            recipient: createRecipientSnapshot(
              memoryCommand ? "all" : recipient,
              enabledPersonas,
            ),
          },
        };
        setPending(true);
      }
      const isTurn = pendingTurn.current.path.endsWith("/turns");
      const receipt = await appRequest<RunDTO>(
        pendingTurn.current.path,
        "POST",
        pendingTurn.current.body,
      );
      if (ticket !== epoch.current) return;
      pendingTurn.current = undefined;
      setPending(false);
      if (isTurn) {
        setInput("");
        setFiles([]);
      }
      setNotice(stateLabels[receipt.status] ?? "Server accepted");
      await refresh(id, ticket);
    } catch (cause) {
      if (ticket === epoch.current) {
        fail(cause);
        const rejected =
          cause instanceof AppAPIError &&
          [
            "INVALID_INPUT",
            "REVISION_CONFLICT",
            "MODEL_NOT_ALLOWED",
            "RECIPIENT_NOT_FOUND",
            "PERSONA_LIMIT",
            "NO_ACTIVE_PERSONA",
            "ATTACHMENT_NOT_AVAILABLE",
            "ATTACHMENT_LIMIT",
            "INPUT_TOO_LARGE",
          ].includes(cause.code);
        if (rejected) {
          pendingTurn.current = undefined;
          setPending(false);
          setNotice(
            "Request rejected before acceptance. Your draft is retained; review the current settings and send explicitly.",
          );
          await refresh(id, ticket).catch(fail);
        } else
          setNotice(
            pendingTurn.current
              ? "Acceptance not confirmed. Retry the same request to recover its receipt."
              : "Save failed. Input is still unsent.",
          );
      }
    } finally {
      if (ticket === epoch.current) setSending(false);
    }
  }
  async function regenerate(message: MessageDTO) {
    if (!room || pendingTurn.current || sending) return;
    pendingTurn.current = {
      roomId: room.id,
      path: `${roomPath(room.id)}/messages/${encodeURIComponent(message.id)}/regenerate`,
      body: {
        requestId: crypto.randomUUID(),
        expectedRevision: message.revision,
      },
    };
    setPending(true);
    await send(true);
  }
  async function editPersona(agent: Agent) {
    if (!room) return;
    const ticket = epoch.current;
    const id = room.id;
    const saved = room.agents.find((item) => item.id === agent.id);
    personaEditRevision.current = saved?.revision;
    const refs = saved?.contextAttachmentIds ?? [];
    setSavedContexts(
      refs.map((id) => ({
        id,
        name: id,
        url: authorizedAttachmentURL(room.id, { id }),
      })),
    );
    setAgentEditor(agent);
    try {
      const meta = await Promise.all(
        refs.map((ref) =>
          appRequest<AttachmentDTO>(
            `${roomPath(id)}/attachments/${encodeURIComponent(ref)}`,
          ),
        ),
      );
      if (ticket === epoch.current)
        setSavedContexts(
          meta.map((item) => ({
            id: item.id,
            name: item.name,
            url: authorizedAttachmentURL(id, item),
          })),
        );
    } catch (cause) {
      fail(cause);
    }
  }
  async function cancel(run: RunDTO) {
    if (!room) return;
    try {
      await appRequest(
        `${roomPath(room.id)}/generations/${encodeURIComponent(run.runId ?? run.id)}/cancel`,
        "POST",
        {},
      );
      await refresh(room.id, epoch.current);
    } catch (cause) {
      fail(cause);
    }
  }
  async function readRunInternal(run: RunDTO) {
    if (!room) return;
    const ticket = epoch.current;
    try {
      const data = await appRequest(
        `${roomPath(room.id)}/generations/${encodeURIComponent(run.runId ?? run.id)}/internal`,
      );
      if (ticket === epoch.current)
        setReader({ title: "Authorized internal result", data });
    } catch (cause) {
      if (ticket === epoch.current) fail(cause);
    }
  }
  async function readMessage(message: MessageDTO, privateReader: boolean) {
    if (!room) return;
    const ticket = epoch.current;
    try {
      const data = await appRequest(
        `${roomPath(room.id)}/messages/${encodeURIComponent(message.id)}/${privateReader ? `private?revision=${message.revision}` : "history"}`,
      );
      if (ticket === epoch.current)
        setReader({
          title: privateReader
            ? "Authorized internal segments"
            : "Revision history",
          data,
        });
    } catch (cause) {
      fail(cause);
    }
  }
  async function correct() {
    if (!room || !correction) return;
    try {
      await appRequest(
        `${roomPath(room.id)}/messages/${encodeURIComponent(correction.message.id)}`,
        "PATCH",
        {
          expectedRevision: correction.message.revision,
          content: correction.content,
        },
      );
      setCorrection(undefined);
      await refresh(room.id, epoch.current);
    } catch (cause) {
      fail(cause);
    }
  }
  async function exportRoom() {
    if (
      !room ||
      !exportState ||
      exportState.complete ||
      exportState.roomId !== room.id
    )
      return;
    const ticket = epoch.current;
    try {
      const result = await appRequest<{ nextCursor?: string }>(
        `${roomPath(room.id)}/export?limit=200${exportState.nextCursor ? `&cursor=${encodeURIComponent(exportState.nextCursor)}` : ""}`,
      );
      if (ticket !== epoch.current) return;
      downloadJSON(`map-room-export-part-${exportState.part}.json`, result);
      setExportState({
        ...exportState,
        nextCursor: result.nextCursor ?? undefined,
        part: exportState.part + 1,
        complete: !result.nextCursor,
      });
    } catch (cause) {
      if (ticket === epoch.current) fail(cause);
    }
  }
  async function older() {
    if (!room || !cursor) return;
    afterRef.current = cursor;
    setPageAfter(cursor);
    setMessages([]);
  }
  function latest() {
    afterRef.current = undefined;
    setPageAfter(undefined);
    setMessages([]);
  }

  if (session === undefined)
    return (
      <main className="p-8 text-zinc-400" role="status">
        Connecting to your conversation server…
      </main>
    );
  if (!session)
    return (
      <>
        <LoginPanel
          onLogin={(value) => {
            signIn(value);
            sessionChanges.current?.postMessage("changed");
          }}
        />
        {error && (
          <div
            role="alert"
            className="fixed bottom-4 inset-x-4 text-center text-red-300"
          >
            {error}
          </div>
        )}
      </>
    );
  return (
    <div className="h-screen w-full flex bg-zinc-950 text-zinc-100">
      <AgentSidebar
        rooms={rooms.map((item) => displayRoom(item))}
        activeRoomId={roomId}
        agents={agents}
        onSwitchRoom={switchRoom}
        onNewRoom={() => setRoomEditor("new")}
        onDeleteRoom={(id) => void remove("room", id)}
        onToggleAgent={(id) => void toggleAgent(id)}
        onDeleteAgent={(id) => void remove("persona", id)}
        onEditAgent={(agent) => void editPersona(agent)}
        onAddAgent={() => {
          personaEditRevision.current = undefined;
          setSavedContexts([]);
          setAgentEditor(null);
        }}
        thinkingAgentIds={
          runs.some(busyRun)
            ? agents.filter((agent) => agent.isEnabled).map((agent) => agent.id)
            : []
        }
        onShowGraph={() => setGraph(true)}
        isOpen={sidebar}
        onClose={() => setSidebar(false)}
      />
      <main className="min-w-0 flex-1 flex flex-col">
        <header className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-zinc-800">
          <div className="flex gap-3 items-center min-w-0">
            <button
              className="map-button md:hidden"
              onClick={() => setSidebar(true)}
              aria-label="Open rooms"
            >
              <Menu size={18} />
            </button>
            <div>
              <h1 className="font-semibold truncate">
                {room?.title ?? "Multi-Agent Nexus"}
              </h1>
              <p className="text-xs text-zinc-500">
                Server conversation ·{" "}
                {room ? `revision ${room.revision}` : "Choose or create a room"}
              </p>
            </div>
          </div>
          <div className="flex gap-2 flex-wrap">
            <button className="map-button" onClick={() => setMigration(true)}>
              Migration
            </button>
            {room && (
              <>
                <button
                  className="map-button"
                  onClick={() => setSearchOpen(true)}
                >
                  Search room
                </button>
                <button
                  className="map-button"
                  onClick={() => setMemoryOpen(true)}
                >
                  Memory
                </button>
                <button
                  className="map-button"
                  onClick={() =>
                    setExportState({
                      roomId: room.id,
                      part: 1,
                      complete: false,
                    })
                  }
                >
                  Export
                </button>
                <button
                  className="map-button"
                  onClick={() => {
                    setRoomEditSnapshot({
                      ...displayRoom(room),
                      revision: room.revision,
                    });
                    setRoomEditor("edit");
                  }}
                  aria-label="Room settings"
                >
                  <Settings size={16} />
                </button>
              </>
            )}
            <button
              className="map-button flex gap-2 items-center"
              onClick={() => void logout()}
            >
              <LogOut size={16} />
              Logout
            </button>
          </div>
        </header>
        {error && (
          <div
            role="alert"
            className="flex justify-between gap-2 border-b border-red-900 bg-red-950/30 px-4 py-3 text-sm text-red-300"
          >
            <span>
              {error}
              {error.includes("REVISION") &&
                " · Reload current settings before editing again."}
            </span>
            <button onClick={() => setError("")} aria-label="Dismiss error">
              <X size={16} />
            </button>
          </div>
        )}
        {notice && (
          <p
            role="status"
            className="px-4 py-2 text-sm text-blue-300 border-b border-zinc-800"
          >
            {notice}
          </p>
        )}
        {!room && (
          <section className="flex-1 flex items-center justify-center p-6">
            <div className="text-center space-y-4">
              <h2 className="text-xl">Your conversations, on the server</h2>
              <p className="text-sm text-zinc-400">
                Create a room or import your legacy browser data.
              </p>
              <button
                className="map-button"
                onClick={() => setRoomEditor("new")}
              >
                Create room
              </button>
            </div>
          </section>
        )}
        {room && (
          <>
            <details className="border-b border-zinc-800 px-4 py-2 text-xs text-zinc-400">
              <summary className="cursor-pointer">
                Generation, decisions and usage ({runs.length})
                {runs[0] &&
                  ` · ${stateLabels[runs[0].status] ?? runs[0].status}${runs[0].errorCode ? ` · ${generationErrorText(runs[0].errorCode)}` : ""}`}
              </summary>
              <div className="max-h-60 overflow-auto space-y-3 py-3">
                {runs.map((run) => (
                  <div
                    key={run.runId ?? run.id}
                    data-run-id={run.runId ?? run.id}
                    className="rounded border border-zinc-800 p-3"
                  >
                    <div className="flex justify-between gap-2">
                      <span>
                        {stateLabels[run.status] ?? run.status} ·{" "}
                        {run.callCount ?? 0} provider calls{" "}
                        {run.errorCode
                          ? `· ${generationErrorText(run.errorCode)}`
                          : ""}
                      </span>
                      {busyRun(run) && (
                        <button
                          className="map-button"
                          onClick={() => void cancel(run)}
                        >
                          Cancel generation
                        </button>
                      )}
                    </div>
                    <button
                      className="map-button mt-2"
                      onClick={() => void readRunInternal(run)}
                    >
                      Read authorized internal result
                    </button>
                    <pre className="mt-2 whitespace-pre-wrap break-words">
                      {JSON.stringify(
                        {
                          decisions: run.decisions,
                          reactions: run.reactions,
                          usage: run.usage,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </div>
                ))}
                {room.legacyDecisions?.length ||
                room.legacyReactions?.length ? (
                  <div className="rounded border border-zinc-800 p-3">
                    <p>Imported decisions and reactions</p>
                    <pre className="mt-2 whitespace-pre-wrap break-words">
                      {JSON.stringify(
                        {
                          decisions: room.legacyDecisions,
                          reactions: room.legacyReactions,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </div>
                ) : null}
              </div>
            </details>
            <section
              className="flex-1 overflow-y-auto p-4 md:p-8"
              aria-label="Conversation"
            >
              {pageAfter && (
                <div className="text-center mb-3">
                  <button className="map-button" onClick={latest}>
                    Latest messages
                  </button>
                </div>
              )}
              {cursor && (
                <div className="text-center mb-5">
                  <button className="map-button" onClick={() => void older()}>
                    Load older messages
                  </button>
                </div>
              )}
              {messages.length === 0 && (
                <p className="text-center text-zinc-500 py-16">
                  No saved messages yet. Add a Persona and select a
                  host-configured model to begin.
                </p>
              )}
              {messages.map((message) => (
                <article
                  key={`${message.id}:${message.revision}`}
                  className={`mb-5 max-w-3xl ${message.role === "user" ? "ml-auto" : "mr-auto"}`}
                  data-message-id={message.id}
                >
                  <div className="text-xs text-zinc-500 mb-2 flex justify-between gap-2">
                    <span>
                      {message.role === "user"
                        ? "You"
                        : speakerName(message.agentId)}{" "}
                      ·{" "}
                      {new Date(
                        message.timestamp ?? message.occurredAt,
                      ).toLocaleString()}
                    </span>
                    <span>revision {message.revision} · saved</span>
                  </div>
                  <div
                    className={`border rounded-2xl p-4 ${message.role === "user" ? "bg-zinc-800 border-zinc-700" : "bg-zinc-900 border-zinc-800"}`}
                  >
                    <p className="whitespace-pre-wrap break-words">
                      {message.content || "(No public text)"}
                    </p>
                    {message.attachments?.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {message.attachments.map((attachment) => (
                          <a
                            className="map-button inline-flex items-center gap-1"
                            key={attachment.id}
                            href={authorizedAttachmentURL(room.id, attachment)}
                            download={attachment.name}
                            rel="noreferrer"
                          >
                            <Paperclip size={14} />
                            {attachment.name} ({attachment.size} bytes)
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex gap-2 mt-2">
                    {reactions
                      .filter((reaction) => reaction.messageId === message.id)
                      .map((reaction) => (
                        <span
                          key={String(reaction.id)}
                          className="text-xs rounded-full border border-zinc-700 px-2 py-1"
                        >
                          {reactionEmoji[String(reaction.semantic)] ??
                            String(reaction.semantic)}{" "}
                          {speakerName(
                            String(reaction.agentId ?? reaction.personaId),
                          )}
                        </span>
                      ))}
                  </div>
                  <div className="flex gap-3 flex-wrap mt-2 text-xs text-zinc-500">
                    <button onClick={() => void readMessage(message, false)}>
                      Revision history
                    </button>
                    <button
                      onClick={() =>
                        setCorrection({ message, content: message.content })
                      }
                    >
                      Correct
                    </button>
                    {message.role === "model" && (
                      <>
                        <button
                          onClick={() => void regenerate(message)}
                          disabled={runs.some(busyRun) || pending || sending}
                        >
                          Regenerate
                        </button>
                        <button onClick={() => void readMessage(message, true)}>
                          Read internal segments
                        </button>
                      </>
                    )}
                    <button onClick={() => void remove("message", message.id)}>
                      Delete
                    </button>
                  </div>
                </article>
              ))}
            </section>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
              className="border-t border-zinc-800 p-4 space-y-3"
            >
              <div className="flex flex-wrap items-center gap-3">
                <label className="text-xs text-zinc-400">
                  Recipient{" "}
                  <select
                    aria-label="Recipient"
                    value={memoryCommand ? "all" : recipient}
                    onChange={(event) =>
                      setRecipient(event.target.value as RecipientSelection)
                    }
                    disabled={memoryCommand || pending || sending}
                    className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 ml-2"
                  >
                    <option value="auto">Auto</option>
                    <option value="all">All Personas</option>
                    {agents
                      .filter((agent) => agent.isEnabled)
                      .map((agent) => (
                        <option key={agent.id} value={`agent:${agent.id}`}>
                          {agent.name}
                        </option>
                      ))}
                    {groups.map((group) => (
                      <option key={group} value={`group:${group}`}>
                        Group: {group}
                      </option>
                    ))}
                  </select>
                </label>
                {session.models.length === 0 && (
                  <span className="text-xs text-amber-300">
                    Provider is not configured · generation unavailable
                  </span>
                )}
                <span className="text-xs text-zinc-500">
                  {room.internalStateSettings.enabled
                    ? "/memory creates private review candidates for Personas with proposal permission."
                    : "Enable internal state separation in Room settings to use /memory."}
                </span>
              </div>
              {memoryCommand && (
                <div
                  className="rounded-lg border border-blue-900 bg-blue-950/30 px-3 py-2 text-sm"
                  role="status"
                >
                  <p className="font-medium">
                    Generate private memory candidates
                  </p>
                  <p className="mt-1">
                    All enabled Personas ·{" "}
                    {enabledPersonas.map((agent) => agent.name).join(", ") ||
                      "None"}
                  </p>
                  {session.memoryLimits && (
                    <p className="mt-1 text-xs text-zinc-300">
                      Up to{" "}
                      {Math.min(
                        enabledPersonas.length,
                        session.memoryLimits.maxCalls,
                      )}{" "}
                      provider calls. Each Persona uses its configured history
                      window, up to {session.memoryLimits.maxHistory} messages
                      through this turn. Run budget · up to{" "}
                      {session.memoryLimits.maxTotalTokens.toLocaleString()}{" "}
                      tokens.
                    </p>
                  )}
                </div>
              )}
              {files.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {files.map((file, index) => (
                    <button
                      type="button"
                      key={index}
                      className="text-xs map-button"
                      disabled={sending || pending}
                      onClick={() =>
                        setFiles((current) =>
                          current.filter((_, at) => at !== index),
                        )
                      }
                    >
                      {file.name} ×
                    </button>
                  ))}
                </div>
              )}
              <div className="flex items-end gap-2">
                <textarea
                  aria-label="Message"
                  className="map-input min-h-20 max-h-48 resize-y"
                  maxLength={32000}
                  placeholder="Write a message…"
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  disabled={sending || pending}
                />
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  accept="text/plain,text/markdown,.md,.txt,image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={(event) => {
                    const incoming: File[] = Array.from(
                      event.currentTarget.files ?? [],
                    );
                    if (
                      files.length + incoming.length > 8 ||
                      incoming.some((file) => file.size > 8 * 1024 * 1024)
                    ) {
                      setError("ATTACHMENT_LIMIT");
                    } else setFiles((current) => [...current, ...incoming]);
                    event.target.value = "";
                  }}
                />
                <button
                  type="button"
                  className="map-button"
                  aria-label="Attach files"
                  disabled={sending || pending}
                  onClick={() => fileInput.current?.click()}
                >
                  <Paperclip size={20} />
                </button>
                <button
                  className="map-button flex items-center gap-2"
                  disabled={
                    sending || pending || (!input.trim() && files.length === 0)
                  }
                >
                  <Send size={18} />
                  {sending ? "Saving…" : "Send"}
                </button>
              </div>
              {pending && (
                <button
                  type="button"
                  className="map-button"
                  disabled={sending}
                  onClick={() => void send(true)}
                >
                  <RefreshCw className="inline mr-2" size={14} />
                  Recover acceptance with the same request
                </button>
              )}
            </form>
          </>
        )}
      </main>
      <RoomModal
        isOpen={!!roomEditor}
        onClose={() => setRoomEditor(undefined)}
        onSave={saveRoom}
        editingRoom={roomEditor === "edit" ? roomEditSnapshot : null}
      />
      <AgentModal
        isOpen={agentEditor !== undefined}
        onClose={() => setAgentEditor(undefined)}
        onSave={saveAgent}
        editingAgent={agentEditor}
        allowedModels={session.models}
        savedContextAttachments={savedContexts}
        onRemoveSavedContext={(id) =>
          setSavedContexts((items) => items.filter((item) => item.id !== id))
        }
      />
      {searchOpen && room && room.id === roomId && (
        <React.Fragment
          key={JSON.stringify([session.workspaceId, session.actorId, room.id])}
        >
          <SearchPanel
            room={room}
            close={() => setSearchOpen(false)}
            onSessionExpired={clearIdentity}
          />
        </React.Fragment>
      )}
      {memoryOpen && room && (
        <React.Fragment key={session.actorId + "/" + room.id}>
          <MemoryPanel
            room={room}
            close={() => setMemoryOpen(false)}
            onSessionExpired={clearIdentity}
          />
        </React.Fragment>
      )}
      {migration && (
        <MigrationPanel
          close={() => setMigration(false)}
          imported={loadRooms}
          onError={fail}
        />
      )}
      {exportState && (
        <DataDialog
          title="Export conversation"
          close={() => setExportState(undefined)}
        >
          <p className="text-sm text-zinc-400 mb-4">
            Exports contain authorized originals, revisions and an attachment
            manifest. Keep these unencrypted files in a protected location.
            Download bounded chunks of up to 200 messages; the export is
            complete only after the final chunk.
          </p>
          {exportState.complete ? (
            <p role="status">
              All {exportState.part - 1} export chunks downloaded.
            </p>
          ) : (
            <button className="map-button" onClick={() => void exportRoom()}>
              Download chunk {exportState.part}
            </button>
          )}
        </DataDialog>
      )}
      {reader && (
        <DataDialog title={reader.title} close={() => setReader(undefined)}>
          <p className="text-xs text-zinc-400 mb-3">
            Access follows your current permissions. Review memory candidates in
            the Room’s Memory panel.
          </p>
          <pre className="text-sm whitespace-pre-wrap break-words max-h-[60vh] overflow-auto">
            {JSON.stringify(reader.data, null, 2)}
          </pre>
        </DataDialog>
      )}
      {correction && (
        <DataDialog
          title="Correct message"
          close={() => setCorrection(undefined)}
        >
          <p className="text-sm text-zinc-400 mb-3">
            Save a new revision. The previous original remains in authorized
            history.
          </p>
          <textarea
            aria-label="Corrected message"
            className="map-input h-48"
            value={correction.content}
            maxLength={32000}
            onChange={(event) =>
              setCorrection({ ...correction, content: event.target.value })
            }
          />
          <button className="map-button mt-3" onClick={() => void correct()}>
            Save correction
          </button>
        </DataDialog>
      )}
      {graph && room && (
        <RelationshipGraphModal
          isOpen={graph}
          onClose={() => setGraph(false)}
          rooms={[displayRoom(room, messages)]}
        />
      )}
    </div>
  );
}
