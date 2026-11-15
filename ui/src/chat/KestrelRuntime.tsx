import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ApiError,
  KestrelApi,
  type Conversation,
  type ConversationDetail,
  type ConversationMessage,
  type PendingApproval,
  type RunEvent,
  type RunStatus,
} from "../api/client";
import { RunEventStream } from "../api/events";

export type KestrelUiState = "connecting" | "ready" | RunStatus | "disconnected";
export type ConnectionState = "connecting" | "connected" | "disconnected";

type KestrelRuntimeValue = {
  api: KestrelApi;
  conversations: readonly Conversation[];
  selectedConversationId: string | null;
  detail: ConversationDetail | null;
  events: readonly RunEvent[];
  state: KestrelUiState;
  connection: ConnectionState;
  error: ApiError | null;
  actionPending: boolean;
  approvalArguments: Record<string, unknown> | null;
  approvalArgumentsLoading: boolean;
  retryApprovalArguments(): void;
  selectConversation(conversationId: string): Promise<void>;
  createConversation(): Promise<void>;
  refreshConversation(): Promise<void>;
  loadEarlierMessages(): Promise<void>;
  stop(): Promise<void>;
  resolveApproval(decision: "approve" | "deny"): Promise<void>;
  clearError(): void;
};

const RuntimeContext = createContext<KestrelRuntimeValue | null>(null);

function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError(0, "CONNECTION_ERROR", error instanceof Error ? error.message : "could not reach Kestrel");
}

function stateFromDetail(value: ConversationDetail): KestrelUiState {
  if (value.activeRun !== undefined) return value.activeRun.status;
  return value.runs[value.runs.length - 1]?.status ?? "ready";
}

function hasActiveRun(value: ConversationDetail, runId: string): boolean {
  return value.activeRun?.id === runId &&
    (value.activeRun.status === "running" || value.activeRun.status === "blocked_on_approval");
}

function isTerminalRunEvent(type: string): boolean {
  return type === "run.completed" || type === "run.failed" || type === "run.cancelled" ||
    type === "run.budget_exhausted";
}

function runtimeMessage(message: ConversationMessage): ThreadMessageLike {
  return {
    id: `${message.conversationId}:${message.sequenceNumber}`,
    role: message.role,
    content: [{ type: "text", text: message.content }],
    createdAt: new Date(message.createdAt),
    metadata: {
      custom: {
        conversationId: message.conversationId,
        sequenceNumber: message.sequenceNumber,
        runId: message.runId,
        contentTruncated: message.contentTruncated,
      },
    },
  };
}

function textFromAppend(message: AppendMessage): string {
  if (message.content.some((part) => part.type !== "text")) {
    throw new ApiError(400, "UNSUPPORTED_MESSAGE", "Kestrel currently accepts text messages only");
  }
  const text = message.content
    .map((part) => part.type === "text" ? part.text : "")
    .join("\n")
    .trim();
  if (text.length === 0) throw new ApiError(400, "EMPTY_MESSAGE", "message cannot be empty");
  return text;
}

function updateUrl(conversationId: string | null, replace = false): void {
  const url = new URL(window.location.href);
  if (conversationId === null) url.searchParams.delete("conversation");
  else url.searchParams.set("conversation", conversationId);
  window.history[replace ? "replaceState" : "pushState"]({}, "", url);
}

function currentUrlConversation(): string | null {
  const value = new URL(window.location.href).searchParams.get("conversation");
  return value === null || value.length === 0 ? null : value;
}

export function KestrelRuntimeProvider({ children }: Readonly<{ children: ReactNode }>) {
  const api = useMemo(() => new KestrelApi(), []);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [state, setState] = useState<KestrelUiState>("connecting");
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [error, setError] = useState<ApiError | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [approvalArguments, setApprovalArguments] = useState<Record<string, unknown> | null>(null);
  const [approvalArgumentsLoading, setApprovalArgumentsLoading] = useState(false);
  const [approvalLoadAttempt, setApprovalLoadAttempt] = useState(0);
  const streamRef = useRef<RunEventStream | null>(null);
  const streamRecoveryRef = useRef<Promise<void> | null>(null);
  const loadVersion = useRef(0);
  const selectedRef = useRef<string | null>(null);
  const detailRef = useRef<ConversationDetail | null>(null);

  useEffect(() => { selectedRef.current = selectedConversationId; }, [selectedConversationId]);
  useEffect(() => { detailRef.current = detail; }, [detail]);

  const refreshList = useCallback(async () => {
    const list = await api.listConversations();
    setConversations(list);
    return list;
  }, [api]);

  const openEventStream = useCallback((conversationId: string, runId: string) => {
    streamRecoveryRef.current = null;
    streamRef.current?.close();
    const ownerVersion = loadVersion.current;
    let stream: RunEventStream;
    stream = new RunEventStream(runId, {
      onConnectionChange(next) {
        if (streamRef.current !== stream || selectedRef.current !== conversationId || loadVersion.current !== ownerVersion) return;
        setConnection(next);
        if (next === "disconnected") {
          setState("disconnected");
          if (streamRecoveryRef.current === null) {
            const recovery = (async () => {
              await api.rebootstrapSession();
              const recovered = await api.getConversation(conversationId);
              if (selectedRef.current !== conversationId || streamRef.current !== stream || loadVersion.current !== ownerVersion) return;
              setDetail(recovered);
              detailRef.current = recovered;
              setState(stateFromDetail(recovered));
              if (!hasActiveRun(recovered, runId)) {
                setConnection("connected");
                stream.close();
                if (streamRef.current === stream) streamRef.current = null;
              }
            })();
            streamRecoveryRef.current = recovery;
            void recovery.catch((cause: unknown) => {
              if (selectedRef.current === conversationId && streamRef.current === stream && loadVersion.current === ownerVersion) {
                setError(asApiError(cause));
              }
            }).finally(() => {
              if (streamRecoveryRef.current === recovery) streamRecoveryRef.current = null;
            });
          }
        } else if (detailRef.current !== null) {
          setState(stateFromDetail(detailRef.current));
        }
      },
      onEvent(event) {
        if (streamRef.current !== stream || selectedRef.current !== conversationId || loadVersion.current !== ownerVersion) return;
        setEvents((current) => current.some((candidate) => candidate.id === event.id)
          ? current
          : [...current, event].sort((left, right) => left.id - right.id));
        if (event.type === "run.blocked_on_approval") setState("blocked_on_approval");
        if (event.type === "run.completed") setState("completed");
        if (event.type === "run.failed") setState("failed");
        if (event.type === "run.cancelled") setState("cancelled");
        if (event.type === "run.budget_exhausted") setState("budget_exhausted");
        if (event.type.startsWith("run.") && event.type !== "run.started") {
          void api.getConversation(conversationId).then((next) => {
            if (
              selectedRef.current !== conversationId ||
              loadVersion.current !== ownerVersion ||
              streamRef.current !== stream
            ) return;
            setDetail(next);
            detailRef.current = next;
            setState(stateFromDetail(next));
            setConnection("connected");
            void refreshList().catch((cause: unknown) => {
              if (selectedRef.current === conversationId && loadVersion.current === ownerVersion) setError(asApiError(cause));
            });
          }).catch((cause: unknown) => {
            if (
              selectedRef.current === conversationId &&
              loadVersion.current === ownerVersion &&
              streamRef.current === stream
            ) {
              setError(asApiError(cause));
            }
          }).finally(() => {
            if (isTerminalRunEvent(event.type) && streamRef.current === stream) streamRef.current = null;
          });
        }
      },
      onReconnect() {
        if (streamRef.current !== stream || selectedRef.current !== conversationId || loadVersion.current !== ownerVersion) return;
        if (streamRecoveryRef.current !== null) return streamRecoveryRef.current;
        return api.getConversation(conversationId).then((next) => {
          if (selectedRef.current !== conversationId || streamRef.current !== stream || loadVersion.current !== ownerVersion) return;
          setDetail(next);
          detailRef.current = next;
          setState(stateFromDetail(next));
          if (!hasActiveRun(next, runId)) {
            stream.close();
            if (streamRef.current === stream) streamRef.current = null;
          }
        }).catch((cause: unknown) => {
          if (selectedRef.current === conversationId && streamRef.current === stream && loadVersion.current === ownerVersion) {
            setError(asApiError(cause));
          }
        });
      },
      onError(cause) {
        if (selectedRef.current === conversationId && streamRef.current === stream && loadVersion.current === ownerVersion) {
          setError(cause);
        }
      },
    });
    streamRef.current = stream;
    stream.connect();
  }, [api, refreshList]);

  const loadConversation = useCallback(async (conversationId: string, updateHistory: boolean) => {
    const version = ++loadVersion.current;
    streamRecoveryRef.current = null;
    streamRef.current?.close();
    streamRef.current = null;
    setSelectedConversationId(conversationId);
    selectedRef.current = conversationId;
    setDetail(null);
    detailRef.current = null;
    setEvents([]);
    setApprovalArguments(null);
    setState("connecting");
    setError(null);
    if (updateHistory) updateUrl(conversationId);
    try {
      const next = await api.getConversation(conversationId);
      if (loadVersion.current !== version) return;
      setDetail(next);
      detailRef.current = next;
      setConversations((current) => current.some((item) => item.id === next.conversation.id)
        ? current.map((item) => item.id === next.conversation.id ? next.conversation : item)
        : [next.conversation, ...current]);
      setConnection("connected");
      setState(stateFromDetail(next));
      const active = next.activeRun;
      if (active !== undefined && (active.status === "running" || active.status === "blocked_on_approval")) {
        openEventStream(conversationId, active.id);
      }
    } catch (cause) {
      if (loadVersion.current !== version) return;
      setError(asApiError(cause));
      setConnection("disconnected");
      setState("disconnected");
    }
  }, [api, openEventStream]);

  const selectConversation = useCallback(async (conversationId: string) => {
    if (selectedRef.current === conversationId) return;
    await loadConversation(conversationId, true);
  }, [loadConversation]);

  const createConversation = useCallback(async () => {
    if (actionPending) return;
    setActionPending(true);
    setError(null);
    try {
      const created = await api.createConversation();
      await refreshList();
      await loadConversation(created.id, true);
    } catch (cause) {
      setError(asApiError(cause));
    } finally {
      setActionPending(false);
    }
  }, [actionPending, api, loadConversation, refreshList]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await api.bootstrapSession();
        if (cancelled) return;
        const list = await refreshList();
        if (cancelled) return;
        setConnection("connected");
        const requested = currentUrlConversation();
        if (requested !== null) {
          await loadConversation(requested, false);
        } else if (list[0] !== undefined) {
          updateUrl(list[0].id, true);
          await loadConversation(list[0].id, false);
        } else {
          const created = await api.createConversation();
          if (cancelled) return;
          setConversations([created]);
          updateUrl(created.id, true);
          await loadConversation(created.id, false);
        }
      } catch (cause) {
        if (cancelled) return;
        setError(asApiError(cause));
        setConnection("disconnected");
        setState("disconnected");
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.close();
    };
  }, [api, loadConversation, refreshList]);

  useEffect(() => {
    const handlePopState = (): void => {
      const conversationId = currentUrlConversation();
      if (conversationId !== null && conversationId !== selectedRef.current) {
        void loadConversation(conversationId, false);
      }
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [loadConversation]);

  const pending = detail?.pendingApproval;
  useEffect(() => {
    setApprovalArguments(null);
    setApprovalArgumentsLoading(false);
    if (pending === undefined || selectedConversationId === null) return;
    let active = true;
    setApprovalArgumentsLoading(true);
    void api.getApprovalArguments(selectedConversationId, pending).then((argumentsValue) => {
      if (active) setApprovalArguments(argumentsValue);
    }).catch((cause: unknown) => {
      if (active) setError(asApiError(cause));
    }).finally(() => {
      if (active) setApprovalArgumentsLoading(false);
    });
    return () => { active = false; };
  }, [api, approvalLoadAttempt, pending?.approvalHandle, selectedConversationId]);

  const retryApprovalArguments = useCallback(() => {
    setError(null);
    setApprovalLoadAttempt((attempt) => attempt + 1);
  }, []);

  const submit = useCallback(async (message: AppendMessage) => {
    const conversationId = selectedRef.current;
    if (conversationId === null) throw new ApiError(400, "NO_CONVERSATION", "select a conversation first");
    if (state === "running" || state === "blocked_on_approval") {
      throw new ApiError(409, "CONVERSATION_BUSY", "finish the active turn before sending another message");
    }
    setError(null);
    setState("running");
    try {
      const started = await api.submitTurn(conversationId, textFromAppend(message));
      openEventStream(conversationId, started.runId);
      const next = await api.getConversation(conversationId);
      if (selectedRef.current !== conversationId) return;
      setDetail(next);
      detailRef.current = next;
      setState(stateFromDetail(next));
      void refreshList();
    } catch (cause) {
      const nextError = asApiError(cause);
      if (selectedRef.current === conversationId) {
        setError(nextError);
        setState(detailRef.current === null ? "ready" : stateFromDetail(detailRef.current));
      }
      throw nextError;
    }
  }, [api, openEventStream, refreshList, state]);

  const stop = useCallback(async () => {
    const current = detailRef.current;
    const conversationId = selectedRef.current;
    if (current?.activeRun === undefined || conversationId === null) return;
    setActionPending(true);
    setError(null);
    try {
      await api.cancelRun(conversationId, current.activeRun.id);
    } catch (cause) {
      if (selectedRef.current === conversationId) setError(asApiError(cause));
    } finally {
      setActionPending(false);
    }
  }, [api]);

  const resolveApproval = useCallback(async (decision: "approve" | "deny") => {
    const current = detailRef.current;
    const conversationId = selectedRef.current;
    const approval = current?.pendingApproval;
    if (current?.activeRun === undefined || approval === undefined || conversationId === null) return;
    if (decision === "approve" && approvalArguments === null) {
      setError(new ApiError(409, "ARGUMENTS_NOT_READY", "wait for the exact approval arguments to load"));
      return;
    }
    setActionPending(true);
    setError(null);
    try {
      await api.resolveApproval(conversationId, current.activeRun.id, approval, decision);
      setState("running");
      const next = await api.getConversation(conversationId);
      if (selectedRef.current === conversationId) {
        setDetail(next);
        detailRef.current = next;
        setState(stateFromDetail(next));
      }
    } catch (cause) {
      if (selectedRef.current === conversationId) setError(asApiError(cause));
    } finally {
      setActionPending(false);
    }
  }, [api, approvalArguments]);

  const refreshConversation = useCallback(async () => {
    const conversationId = selectedRef.current;
    if (conversationId === null) {
      const version = ++loadVersion.current;
      setState("connecting");
      setConnection("connecting");
      setError(null);
      try {
        await api.rebootstrapSession();
        if (loadVersion.current !== version || selectedRef.current !== null) return;
        const list = await refreshList();
        if (loadVersion.current !== version || selectedRef.current !== null) return;
        const requested = currentUrlConversation();
        if (requested !== null) {
          await loadConversation(requested, false);
        } else if (list[0] !== undefined) {
          updateUrl(list[0].id, true);
          await loadConversation(list[0].id, false);
        } else {
          const created = await api.createConversation();
          if (loadVersion.current !== version || selectedRef.current !== null) return;
          setConversations([created]);
          updateUrl(created.id, true);
          await loadConversation(created.id, false);
        }
      } catch (cause) {
        if (loadVersion.current !== version || selectedRef.current !== null) return;
        setError(asApiError(cause));
        setConnection("disconnected");
        setState("disconnected");
      }
      return;
    }
    const version = loadVersion.current;
    try {
      const next = await api.getConversation(conversationId);
      if (selectedRef.current !== conversationId || loadVersion.current !== version) return;
      setDetail(next);
      detailRef.current = next;
      setState(stateFromDetail(next));
      setConnection("connected");
      setError(null);
      const active = next.activeRun;
      if (streamRef.current === null && active !== undefined && hasActiveRun(next, active.id)) {
        openEventStream(conversationId, active.id);
      }
    } catch (cause) {
      if (selectedRef.current !== conversationId || loadVersion.current !== version) return;
      setError(asApiError(cause));
      setConnection("disconnected");
      setState("disconnected");
    }
  }, [api, loadConversation, openEventStream, refreshList]);

  const loadEarlierMessages = useCallback(async () => {
    const current = detailRef.current;
    const conversationId = selectedRef.current;
    const cursor = current?.messagePage.nextCursor;
    if (current === null || current === undefined || conversationId === null || cursor === null) return;
    const version = loadVersion.current;
    setActionPending(true);
    try {
      const previous = await api.getConversation(conversationId, cursor);
      if (selectedRef.current !== conversationId || loadVersion.current !== version) return;
      setDetail((latest) => latest === null ? previous : {
        ...latest,
        messages: [...previous.messages, ...latest.messages],
        messagePage: previous.messagePage,
      });
    } catch (cause) {
      if (selectedRef.current === conversationId && loadVersion.current === version) setError(asApiError(cause));
    } finally {
      setActionPending(false);
    }
  }, [api]);

  const assistantMessages = useMemo(() => detail?.messages.map(runtimeMessage) ?? [], [detail?.messages]);
  const isRunning = state === "running";
  const sendDisabled = selectedConversationId === null || state === "connecting" || state === "running" ||
    state === "blocked_on_approval" || state === "disconnected";
  const runtime = useExternalStoreRuntime({
    messages: assistantMessages,
    isRunning,
    isSendDisabled: sendDisabled,
    activeRunId: detail?.activeRun?.id,
    onNew: submit,
    onCancel: stop,
  });

  const context = useMemo<KestrelRuntimeValue>(() => ({
    api,
    conversations,
    selectedConversationId,
    detail,
    events,
    state,
    connection,
    error,
    actionPending,
    approvalArguments,
    approvalArgumentsLoading,
    retryApprovalArguments,
    selectConversation,
    createConversation,
    refreshConversation,
    loadEarlierMessages,
    stop,
    resolveApproval,
    clearError: () => setError(null),
  }), [
    actionPending, api, approvalArguments, approvalArgumentsLoading, connection, conversations,
    createConversation, detail, error, events, loadEarlierMessages, refreshConversation,
    resolveApproval, retryApprovalArguments, selectConversation, selectedConversationId, state, stop,
  ]);

  return (
    <RuntimeContext.Provider value={context}>
      <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
    </RuntimeContext.Provider>
  );
}

export function useKestrelRuntime(): KestrelRuntimeValue {
  const value = useContext(RuntimeContext);
  if (value === null) throw new Error("useKestrelRuntime must be used inside KestrelRuntimeProvider");
  return value;
}

export function formatState(state: KestrelUiState): string {
  switch (state) {
    case "blocked_on_approval": return "Waiting for approval";
    case "budget_exhausted": return "Budget exhausted";
    case "ready": return "Ready";
    default: return state.charAt(0).toUpperCase() + state.slice(1);
  }
}

export function approvalSummary(approval: PendingApproval): string {
  return `${approval.tool} · ${approval.risk} risk`;
}
