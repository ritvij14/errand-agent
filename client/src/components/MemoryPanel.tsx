import { useState } from "react";
import type { MemoryFact } from "../shared/api-client.js";

type Props = {
  facts: MemoryFact[];
  busy: boolean;
  onEdit: (id: string, value: string) => void;
  onConfirm: (id: string) => void;
  onReject: (id: string) => void;
  onForget: (id: string) => void;
};

/** Display value per key; the panel never invents labels the server didn't send. */
const AREA_LABELS: Record<string, string> = {
  indiranagar: "Indiranagar",
  koramangala: "Koramangala",
  hsr_layout: "HSR Layout",
  jayanagar: "Jayanagar",
  whitefield: "Whitefield",
};
const display = (fact: MemoryFact): string => {
  if (fact.key === "area") return AREA_LABELS[fact.value] ?? fact.value;
  if (fact.key === "earliest_time") return `not before ${fact.value}`;
  return fact.value;
};

/**
 * The memory side panel (FR-12, 2.5.8): view facts with stated/inferred labels, edit
 * (source becomes stated), confirm/reject inferred ones, forget. Same code as chat —
 * the buttons only call the endpoints.
 */
export function MemoryPanel({ facts, busy, onEdit, onConfirm, onReject, onForget }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  return (
    <section aria-label="Memory" className="mt-4 border-t border-neutral-200 pt-2 text-xs">
      <h2 className="mb-1 font-medium text-neutral-700">Saved preferences</h2>
      {facts.length === 0 && <p className="text-neutral-500">Nothing saved yet.</p>}
      <ul className="space-y-1">
        {facts.map((fact) => (
          <li key={fact.id} className="rounded border border-neutral-200 p-1">
            <p className="text-neutral-800">
              {fact.key === "preferred_provider" && fact.service ? `${fact.service}: ` : ""}
              <span className="font-medium">{display(fact)}</span>
            </p>
            <p className="text-neutral-500">
              {fact.source === "stated" ? "you told me" : "I worked out"}
              {fact.status === "awaiting_confirmation" ? " — waiting for your confirmation" : ""}
            </p>
            {fact.evidence && <p className="text-neutral-400">“{fact.evidence}”</p>}
            {editing === fact.id ? (
              <span className="flex gap-1">
                <input
                  aria-label="New value"
                  className="w-full rounded border border-neutral-300 px-1"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <button
                  className="rounded bg-neutral-900 px-1 text-white disabled:opacity-50"
                  disabled={busy || draft.trim() === ""}
                  onClick={() => {
                    onEdit(fact.id, draft.trim());
                    setEditing(null);
                  }}
                >
                  Save
                </button>
              </span>
            ) : (
              <span className="flex gap-1">
                <button
                  className="rounded border border-neutral-300 px-1"
                  disabled={busy}
                  onClick={() => {
                    setEditing(fact.id);
                    setDraft(fact.value);
                  }}
                >
                  Edit
                </button>
                {fact.status === "awaiting_confirmation" ? (
                  <>
                    <button
                      className="rounded bg-neutral-900 px-1 text-white"
                      disabled={busy}
                      onClick={() => onConfirm(fact.id)}
                    >
                      Confirm
                    </button>
                    <button
                      className="rounded border border-neutral-300 px-1"
                      disabled={busy}
                      onClick={() => onReject(fact.id)}
                    >
                      Reject
                    </button>
                  </>
                ) : (
                  <button
                    className="rounded border border-neutral-300 px-1"
                    disabled={busy}
                    onClick={() => onForget(fact.id)}
                  >
                    Forget
                  </button>
                )}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
