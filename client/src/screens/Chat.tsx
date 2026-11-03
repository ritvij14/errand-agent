import { useState } from "react";
import {
  useConversation,
  useConversations,
  useCreateConversation,
  useDecideApproval,
  useSendMessage,
  useSignOut,
  useMemory,
  useEditMemory,
  useConfirmMemory,
  useRejectMemory,
  useForgetMemory,
  useTrace,
} from "../shared/queries.js";
import type { Message } from "../shared/api-client.js";
import { MemoryPanel } from "../components/MemoryPanel.js";
import { TracePanel } from "../components/TracePanel.js";
import {
  isApprovalCard,
  isBookingsList,
  isMemoryConfirm,
  isOptionBlocks,
  isProviderDetails,
} from "../shared/parts.js";
import { OptionBlocks } from "../components/OptionBlocks.js";
import { ApprovalCard } from "../components/ApprovalCard.js";
import { BookingsList } from "../components/BookingsList.js";
import { ProviderDetails } from "../components/ProviderDetails.js";
import { MemoryConfirmCard } from "../components/MemoryConfirmCard.js";

// The chat page: conversation list + message view + composer (§ 2.4). Send is
// disabled while a reply is pending (2.3: both sides block overlapping sends).
export function Chat() {
  const conversations = useConversations(true);
  const create = useCreateConversation();
  const signOut = useSignOut();
  const [selected, setSelected] = useState<string | null>(null);
  const conversation = useConversation(selected, selected !== null);
  const sendMessage = useSendMessage(selected ?? "");
  const decide = useDecideApproval(selected ?? "");
  const memory = useMemory(true);
  const editMemory = useEditMemory();
  const confirmMemory = useConfirmMemory();
  const rejectMemory = useRejectMemory();
  const forgetMemory = useForgetMemory();
  // FR-13 (U35): the latest reply's run loads automatically; a reply's "trace" link switches the panel
  const messages = conversation.data?.messages ?? [];
  const latestRunId = messages.filter((m) => m.role === "agent" && m.runId).at(-1)?.runId ?? null;
  const [traceRunId, setTraceRunId] = useState<string | null>(null); // explicit choice wins over latest
  const shownRunId = traceRunId ?? latestRunId;
  const [draft, setDraft] = useState("");
  // 2.3: nothing new is sent — typed, tapped or clicked — while a reply is pending
  const busy = sendMessage.isPending || decide.isPending || create.isPending || signOut.isPending;
  // the newest card on screen: a typed yes / no answers that card (§ 2.5.5 rule 1, 2.5.8)
  const newestCard = messages
    .flatMap((m) => m.parts ?? [])
    .filter((p) => isApprovalCard(p) || isMemoryConfirm(p))
    .at(-1);
  const shownCardId = isApprovalCard(newestCard) ? newestCard.approvalId : undefined;
  const shownFactId = isMemoryConfirm(newestCard) ? newestCard.factId : undefined;
  const trace = useTrace(shownRunId, shownRunId !== null);
  // a trace picked in one conversation never follows the user into another
  const open = (id: string) => {
    setSelected(id);
    setTraceRunId(null);
  };
  const startConversation = () => create.mutate(undefined, { onSuccess: (c) => open(c.id) });
  const send = () => {
    const text = draft.trim();
    if (!text || !selected || busy) return;
    setDraft("");
    sendMessage.mutate({ text, approvalId: shownCardId, memoryFactId: shownFactId });
  };

  return (
    <div className="flex h-screen w-full flex-col p-4">
      <header className="mb-4 flex items-center justify-between border-b border-neutral-200 pb-2">
        <h1 className="text-lg font-semibold">errand-agent</h1>
        <button className="text-xs text-neutral-500 underline" onClick={() => signOut.mutate()}>
          Sign out
        </button>
      </header>
      <div className="flex flex-1 gap-4 overflow-hidden">
        <aside className="w-48 shrink-0 overflow-y-auto">
          <button
            className="mb-2 w-full rounded border border-neutral-300 px-2 py-1 text-sm"
            onClick={startConversation}
            disabled={create.isPending}
          >
            + New conversation
          </button>
          {(conversations.data ?? []).map((c) => (
            <button
              key={c.id}
              className={`mb-1 block w-full truncate rounded px-2 py-1 text-left text-sm ${selected === c.id ? "bg-neutral-200" : ""}`}
              onClick={() => open(c.id)}
            >
              {c.busy ? "⋯ " : ""}
              {c.title}
            </button>
          ))}
          <MemoryPanel
            facts={memory.data ?? []}
            busy={
              busy ||
              editMemory.isPending ||
              confirmMemory.isPending ||
              rejectMemory.isPending ||
              forgetMemory.isPending
            }
            onEdit={(id, value) => editMemory.mutate({ id, value })}
            onConfirm={(id) => confirmMemory.mutate({ id })}
            onReject={(id) => rejectMemory.mutate({ id })}
            onForget={(id) => forgetMemory.mutate({ id })}
          />
        </aside>
        {selected === null ? (
          <main className="flex flex-1 items-center justify-center rounded-lg border border-neutral-200">
            <button
              className="rounded-lg bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-50"
              onClick={startConversation}
              disabled={create.isPending}
            >
              Start a new conversation
            </button>
          </main>
        ) : (
          <main className="flex flex-1 flex-col overflow-hidden">
            <div className="flex-1 space-y-2 overflow-y-auto rounded-lg border border-neutral-200 p-3">
              {messages.map((m: Message) => (
                <div
                  key={m.id}
                  className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${m.role === "user" ? "ml-auto bg-neutral-900 text-white" : "bg-neutral-100"}`}
                >
                  <p className="whitespace-pre-wrap">{m.text}</p>
                  {m.parts?.map((part, i) =>
                    isOptionBlocks(part) ? (
                      <OptionBlocks
                        key={i}
                        blocks={part.blocks}
                        disabled={busy}
                        onConfirm={(text) => sendMessage.mutate({ text })}
                      />
                    ) : isApprovalCard(part) ? (
                      <ApprovalCard
                        key={i}
                        card={part}
                        disabled={busy}
                        onDecide={(approvalId, decision) => decide.mutate({ approvalId, decision })}
                      />
                    ) : isMemoryConfirm(part) ? (
                      <MemoryConfirmCard
                        key={i}
                        card={part}
                        disabled={busy}
                        onAnswer={(memoryFactId, answer) =>
                          sendMessage.mutate({ text: answer, memoryFactId })
                        }
                      />
                    ) : isBookingsList(part) ? (
                      <BookingsList key={i} part={part} />
                    ) : isProviderDetails(part) ? (
                      <ProviderDetails key={i} part={part} />
                    ) : null,
                  )}
                  {/* FR-13: each agent reply links to its own run's trace */}
                  {m.role === "agent" && m.runId && (
                    <button
                      className="mt-1 text-[10px] text-neutral-500 underline"
                      onClick={() => setTraceRunId(m.runId ?? null)}
                    >
                      trace
                    </button>
                  )}
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
              <button
                className="rounded-lg bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-50"
                onClick={send}
                disabled={!selected || busy}
              >
                {busy ? "…" : "Send"}
              </button>
            </footer>
          </main>
        )}
        <aside
          aria-label="Trace panel"
          className="w-[32rem] shrink-0 overflow-y-auto rounded-lg border border-neutral-200 p-3"
        >
          <TracePanel trace={trace.data ?? null} />
        </aside>
      </div>
    </div>
  );
}
