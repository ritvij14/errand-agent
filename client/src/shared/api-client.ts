// The only module in the client that calls fetch. Components and hooks go through
// these functions; CSRF headers match what the server's csrfGuard requires (§ 2.5.1).
export class ApiError extends Error {
  status: number;
  code?: string;
  details?: Record<string, string>;

  constructor(status: number, body: { error?: string; code?: string; details?: Record<string, string> }) {
    super(body.error ?? `${status} error`);
    this.name = "ApiError";
    this.status = status;
    this.code = body.code;
    this.details = body.details;
  }
}

const request = async <T>(
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  body?: unknown,
): Promise<T> => {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers:
      method === "GET" ? undefined : { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  const parsed = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
  if (!res.ok) throw new ApiError(res.status, parsed as never);
  return (parsed as { data: T }).data;
};

export type Me = { user: { id: string; username: string } };
export type MemoryFact = {
  id: string;
  key: string;
  service: string | null;
  value: string;
  source: "stated" | "inferred";
  status: "active" | "awaiting_confirmation" | "forgotten";
  evidence?: string | null;
  updatedAt: number;
};
export type ConversationSummary = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  busy: boolean;
};
export type Message = { id: string; role: "user" | "agent"; text: string; parts: unknown[]; runId?: string };
export type Reply = {
  runId: string;
  outcome: string;
  message: { id: string; role: string; text: string; parts: unknown[] };
};
export type TraceEventView = {
  seq: number;
  type: string;
  clockAt: number;
  durationMs: number | null;
  data: Record<string, unknown>;
};
export type TraceView = {
  run: {
    id: string;
    conversationId: string;
    trigger: string;
    startedAt: number;
    endedAt: number | null;
    outcome: string | null;
    modelCalls: number;
    toolCalls: number;
  };
  events: TraceEventView[];
};

export const api = {
  me: () => request<Me>("/auth/me", "GET"),
  signIn: (username: string, password: string) =>
    request<Me>("/auth/sign-in", "POST", { username, password }),
  signUp: (username: string, password: string) =>
    request<Me>("/auth/sign-up", "POST", { username, password }),
  signOut: () => request<void>("/auth/sign-out", "POST"),
  conversations: () => request<ConversationSummary[]>("/conversations", "GET"),
  createConversation: () => request<ConversationSummary>("/conversations", "POST", {}),
  conversation: (id: string) =>
    request<{ conversation: ConversationSummary; messages: Message[]; busy: boolean }>(
      `/conversations/${id}`,
      "GET",
    ),
  /** `approvalId` / `memoryFactId`: the card on screen, so a yes / no answers that card (§ 2.5.5 rule 1, 2.5.8) */
  sendMessage: (
    id: string,
    text: string,
    clientMessageId: string,
    approvalId?: string,
    memoryFactId?: string,
  ) =>
    request<Reply>(`/conversations/${id}/messages`, "POST", {
      text,
      clientMessageId,
      approvalId,
      memoryFactId,
    }),
  decideApproval: (approvalId: string, decision: "approve" | "decline") =>
    request<Reply>(`/approvals/${approvalId}/decision`, "POST", { decision }),
  // FR-12 (U34): the memory panel — the same facts chat saves, listed and edited directly
  memory: () => request<MemoryFact[]>("/memory", "GET"),
  updateMemory: (id: string, value: string) => request<MemoryFact>(`/memory/${id}`, "PUT", { value }),
  confirmMemory: (id: string) => request<MemoryFact>(`/memory/${id}/confirm`, "POST", {}),
  rejectMemory: (id: string) => request<MemoryFact>(`/memory/${id}/reject`, "POST", {}),
  forgetMemory: (id: string) => request<{ id: string; forgotten: boolean }>(`/memory/${id}`, "DELETE", {}),
  // FR-13 (U35): one run's trace — 404 for another user's run
  trace: (runId: string) => request<TraceView>(`/runs/${runId}/trace`, "GET"),
};
