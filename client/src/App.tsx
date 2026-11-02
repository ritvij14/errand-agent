import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

type Health = { status: string };
type ChatMessage = { role: "user"; content: string };

type ChatReply = { sessionId: string; messages: ChatMessage[] };

async function json<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: () => json<Health>("/api/health"),
    refetchInterval: 30_000,
  });
}

export function App() {
  const health = useHealth();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sessionId, setSessionId] = useState<string | undefined>();

  async function send() {
    const message = draft.trim();
    if (!message) return;
    setDraft("");
    const reply = await json<ChatReply>("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, message }),
    });
    setSessionId(reply.sessionId);
    setMessages((m) => [...m, ...reply.messages]);
  }

  return (
    <div className="mx-auto flex h-screen max-w-3xl flex-col p-4">
      <header className="mb-4 flex items-center justify-between border-b border-neutral-200 pb-2">
        <h1 className="text-lg font-semibold">errand-agent</h1>
        <span
          className={
            "rounded-full px-2 py-0.5 text-xs " +
            (health.data?.status === "ok"
              ? "bg-green-100 text-green-800"
              : health.isError
                ? "bg-red-100 text-red-800"
                : "bg-neutral-100 text-neutral-600")
          }
        >
          {health.data ? `server ${health.data.status}` : "connecting…"}
        </span>
      </header>

      <main className="flex-1 space-y-2 overflow-y-auto rounded-lg border border-neutral-200 p-3">
        {messages.length === 0 && <p className="text-sm text-neutral-500">Start by asking for a service.</p>}
        {messages.map((m, i) => (
          <div key={i} className="max-w-[75%] rounded-lg bg-neutral-100 px-3 py-2 text-sm">
            {m.content}
          </div>
        ))}
      </main>

      <footer className="mt-3 flex gap-2">
        <input
          className="flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:outline-none"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void send()}
          placeholder='e.g. "Find a plumber for my kitchen tap this week"'
        />
        <button
          className="rounded-lg bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-700"
          onClick={() => void send()}
        >
          Send
        </button>
      </footer>

      <aside className="mt-2 text-xs text-neutral-400">
        Trace panel: built with the traces feature (MH-7).
      </aside>
    </div>
  );
}
