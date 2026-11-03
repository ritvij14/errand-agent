import { useState } from "react";
import type { TraceView } from "../shared/api-client.js";

type Props = { trace: TraceView | null };

// 2.5.9: one timeline line per event, coloured by type; a click expands all fields.
const colourOf = (type: string): string =>
  ({
    run_started: "bg-blue-100 text-blue-800",
    model_call: "bg-violet-100 text-violet-800",
    state_transition: "bg-emerald-100 text-emerald-800",
    fact_changed: "bg-teal-100 text-teal-800",
    tool_call: "bg-amber-100 text-amber-800",
    approval_event: "bg-orange-100 text-orange-800",
    operation_event: "bg-rose-100 text-rose-800",
    memory_event: "bg-cyan-100 text-cyan-800",
    limit_hit: "bg-red-100 text-red-800",
    error: "bg-red-200 text-red-900",
  })[type] ?? "bg-neutral-100 text-neutral-700";

/** The event's one-line summary, e.g. "tool_call book → timeout" / "state searching → choosing". */
const lineOf = (e: TraceView["events"][number]): string => {
  const d = e.data;
  if (e.type === "tool_call")
    return `${String(d.tool ?? "")} → ${d.ok ? "ok" : String(d.errorCode ?? "?")}${e.durationMs !== null ? ` (${e.durationMs} ms)` : ""}`;
  if (e.type === "state_transition") return `${String(d.fromPhase ?? "")} → ${String(d.toPhase ?? "")}`;
  if (e.type === "fact_changed")
    return `${String(d.key ?? "")}: ${String(d.oldValue ?? "—")} → ${String(d.newValue ?? "—")}`;
  if (e.type === "model_call") return `${String(d.job ?? "")}`;
  if (e.type === "memory_event") return `${String(d.event ?? "")} ${String(d.key ?? "")}`;
  return e.type;
};

/**
 * The trace panel (MH-7, FR-13): the run's events in order, expandable per line. The
 * page picks which run via the reply links; this component only shows what it gets.
 */
export function TracePanel({ trace }: Props) {
  const [open, setOpen] = useState<number | null>(null);
  if (!trace)
    return (
      <section aria-label="Trace" className="text-xs text-neutral-500">
        <h2 className="mb-1 font-medium text-neutral-700">Trace</h2>
        <p>No trace yet — send a message, then load its run.</p>
      </section>
    );
  return (
    <section aria-label="Trace" className="text-xs">
      <h2 className="mb-1 font-medium text-neutral-700">
        Trace · {trace.run.outcome ?? "running"} · {trace.run.modelCalls} model / {trace.run.toolCalls} tool
        calls
      </h2>
      <ol className="space-y-0.5">
        {trace.events.map((e) => (
          <li key={e.seq}>
            <button
              aria-expanded={open === e.seq}
              className={`trace-${e.type} w-full rounded px-1 py-0.5 text-left ${colourOf(e.type)}`}
              onClick={() => setOpen(open === e.seq ? null : e.seq)}
            >
              <span className="font-mono">#{e.seq}</span> {lineOf(e)}
            </button>
            {open === e.seq && (
              <pre className="mt-0.5 ml-3 overflow-x-auto rounded bg-neutral-900 p-1 font-mono text-[10px] text-neutral-100">
                {JSON.stringify(e.data, null, 1)}
              </pre>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
