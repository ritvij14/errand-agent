import { randomUUID } from "node:crypto";
import type { Db } from "../shared/db.js";

// Repository: conversations, runs, messages. Only this module talks to those tables.

export type Conversation = { id: string; user_id: string; title: string; created_at: number; updated_at: number };
export type Run = {
  id: string;
  conversation_id: string;
  user_id: string;
  trigger: "message" | "pick" | "approval_decision" | "recovery";
  started_at: number;
  ended_at: number | null;
  outcome: string | null;
  model_calls: number;
  tool_calls: number;
};
export type Message = {
  id: string;
  conversation_id: string;
  run_id: string | null;
  role: "user" | "agent";
  text: string;
  parts: unknown[];
  client_message_id: string | null;
  created_at: number;
};

export const conversationRepo = (db: Db) => {
  const insertConversation = db.prepare(`INSERT INTO conversation (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`);
  const insertRun = db.prepare(
    `INSERT INTO run (id, conversation_id, user_id, trigger, started_at, model_calls, tool_calls) VALUES (?, ?, ?, ?, ?, 0, 0)`,
  );
  const insertMessage = db.prepare(
    `INSERT INTO message (id, conversation_id, run_id, role, text, parts, client_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  return {
    createConversation: (userId: string, nowMs: number): Conversation => {
      const id = randomUUID();
      insertConversation.run(id, userId, "New conversation", nowMs, nowMs);
      return db.prepare(`SELECT * FROM conversation WHERE id = ?`).get(id) as Conversation;
    },
    listConversations: (userId: string): Conversation[] =>
      db.prepare(`SELECT * FROM conversation WHERE user_id = ? ORDER BY updated_at DESC`).all(userId) as Conversation[],
    getConversation: (id: string, userId: string): Conversation | undefined =>
      db.prepare(`SELECT * FROM conversation WHERE id = ? AND user_id = ?`).get(id, userId) as Conversation | undefined,
    touchConversation: (id: string, nowMs: number): void => {
      db.prepare(`UPDATE conversation SET updated_at = ? WHERE id = ?`).run(nowMs, id);
    },
    createRun: (conversationId: string, userId: string, trigger: Run["trigger"], nowMs: number): Run => {
      const id = randomUUID();
      insertRun.run(id, conversationId, userId, trigger, nowMs);
      return db.prepare(`SELECT * FROM run WHERE id = ?`).get(id) as Run;
    },
    finishRun: (id: string, outcome: string, endedAt: number, modelCalls: number, toolCalls: number): void => {
      db.prepare(`UPDATE run SET ended_at = ?, outcome = ?, model_calls = ?, tool_calls = ? WHERE id = ?`).run(
        endedAt,
        outcome,
        modelCalls,
        toolCalls,
        id,
      );
    },
    addMessage: (conversationId: string, runId: string | null, role: "user" | "agent", text: string, parts: unknown[], nowMs: number, clientMessageId?: string): Message => {
      const id = randomUUID();
      insertMessage.run(id, conversationId, runId, role, text, JSON.stringify(parts), clientMessageId ?? null, nowMs);
      return { ...(db.prepare(`SELECT * FROM message WHERE id = ?`).get(id) as Message), parts };
    },
    listMessages: (conversationId: string): Message[] =>
      (db.prepare(`SELECT * FROM message WHERE conversation_id = ? ORDER BY created_at, rowid`).all(conversationId) as Message[]).map((m) => ({
        ...m,
        parts: JSON.parse(String(m.parts)) as unknown[],
      })),
    findUserMessageByClientMessageId: (conversationId: string, clientMessageId: string): Message | undefined =>
      db
        .prepare(`SELECT * FROM message WHERE conversation_id = ? AND client_message_id = ?`)
        .get(conversationId, clientMessageId) as Message | undefined,
    findAgentReplyForRun: (runId: string): Message | undefined =>
      db.prepare(`SELECT * FROM message WHERE run_id = ? AND role = 'agent'`).get(runId) as Message | undefined,
  };
};