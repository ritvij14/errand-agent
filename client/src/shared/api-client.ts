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

const request = async <T>(path: string, method: "GET" | "POST" | "PUT" | "DELETE", body?: unknown): Promise<T> => {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: method === "GET" ? undefined : { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  const parsed = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
  if (!res.ok) throw new ApiError(res.status, parsed as never);
  return (parsed as { data: T }).data;
};

export type Me = { user: { id: string; username: string } };
export type ConversationSummary = { id: string; title: string; createdAt: number; updatedAt: number; busy: boolean };
export type Message = { id: string; role: "user" | "agent"; text: string; parts: unknown[]; runId?: string };
export type Reply = { runId: string; outcome: string; message: { id: string; role: string; text: string; parts: unknown[] } };

export const api = {
  me: () => request<Me>("/auth/me", "GET"),
  signIn: (username: string, password: string) => request<Me>("/auth/sign-in", "POST", { username, password }),
  signUp: (username: string, password: string) => request<Me>("/auth/sign-up", "POST", { username, password }),
  signOut: () => request<void>("/auth/sign-out", "POST"),
  conversations: () => request<ConversationSummary[]>("/conversations", "GET"),
  createConversation: () => request<ConversationSummary>("/conversations", "POST", {}),
  conversation: (id: string) => request<{ conversation: ConversationSummary; messages: Message[]; busy: boolean }>(`/conversations/${id}`, "GET"),
  sendMessage: (id: string, text: string, clientMessageId: string) => request<Reply>(`/conversations/${id}/messages`, "POST", { text, clientMessageId }),
};