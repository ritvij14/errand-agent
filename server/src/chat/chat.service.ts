import { randomUUID } from "node:crypto";

type ChatMessage = { role: "user"; content: string; at: string };
type ChatSession = { sessionId: string; messages: ChatMessage[] };

// In-memory scaffold stub. Chat history lives in SQLite once the chat-sessions feature (MH-1) is built.
const sessions = new Map<string, ChatSession>();

export const chatService = {
  append(message: string): ChatSession {
    const sessionId = randomUUID();
    const entry: ChatMessage = { role: "user", content: message, at: new Date().toISOString() };
    const session: ChatSession = { sessionId, messages: [entry] };
    sessions.set(sessionId, session);
    return session;
  },
};
