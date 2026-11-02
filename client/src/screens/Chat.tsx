import { useState } from "react";
import { useConversation, useConversations, useCreateConversation, useSendMessage, useSignOut } from "../shared/queries.js";
import type { Message } from "../shared/api-client.js";

// The chat page: conversation list + message view + composer (§ 2.4). Send is
// disabled while a reply is pending (2.3: both sides block overlapping sends).
export function Chat() {
  const conversations = useConversations(true);
  const create = useCreateConversation();
  const signOut = useSignOut();
  const [selected, setSelected] = useState<string | null>(null);
  const conversation = useConversation(selected, selected !== null);
  const sendMessage = useSendMessage(selected ?? "");
  const [draft, setDraft] = useState("");
  const busy = sendMessage.isPending || create.isPending || signOut.isPending;

  const send = () => {
    const text = draft.trim();
    if (!text || !selected || busy) return;
    setDraft("");
    sendMessage.mutate(text);
  };

  return (
    <div className="mx-auto flex h-screen max-w-3xl flex-col p-4">
      <header className="mb-4 flex items-center justify-between border-b border-neutral-200 pb-2">
        <h1 className="text-lg font-semibold">errand-agent</h1>
        <button className="text-xs text-neutral-500 underline" onClick={() => signOut.mutate()}>
          Sign out
        </button>
      </header>
      <div className="flex flex-1 gap-4 overflow-hidden">
        <aside className="w-48 shrink-0 overflow-y-auto">
          <button className="mb-2 w-full rounded border border-neutral-300 px-2 py-1 text-sm" onClick={() => create.mutate()} disabled={create.isPending}>
            + New conversation
          </button>
          {(conversations.data ?? []).map((c) => (
            <button
              key={c.id}
              className={`mb-1 block w-full truncate rounded px-2 py-1 text-left text-sm ${selected === c.id ? "bg-neutral-200" : ""}`}
              onClick={() => setSelected(c.id)}
            >
              {c.busy ? "⋯ " : ""}
              {c.title}
            </button>
          ))}
        </aside>
        <main className="flex flex-1 flex-col overflow-hidden">
          <div className="flex-1 space-y-2 overflow-y-auto rounded-lg border border-neutral-200 p-3">
            {(conversation.data?.messages ?? []).map((m: Message) => (
              <div key={m.id} className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${m.role === "user" ? "ml-auto bg-neutral-900 text-white" : "bg-neutral-100"}`}>
                <p className="whitespace-pre-wrap">{m.text}</p>
                {m.parts?.map((part, i) => <RenderedPart key={i} part={part} />)}
              </div>
            ))}
          </div>
          <footer className="mt-3 flex gap-2">
            <input
              className="flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
              placeholder='e.g. "Find a plumber this week in HSR Layout"'
              disabled={!selected || busy}
            />
            <button className="rounded-lg bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-50" onClick={send} disabled={!selected || busy}>
              {busy ? "…" : "Send"}
            </button>
          </footer>
        </main>
      </div>
    </div>
  );
}

// Structural parts (option blocks, approval cards…) — added in later units (U26).
// The placeholder keeps the renderer's shape without speculative UI.
function RenderedPart(_props: { part: unknown }) {
  return null;
}