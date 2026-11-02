import { useState } from "react";
import { rupees, type OptionBlock } from "../shared/parts.js";

type Props = { blocks: OptionBlock[]; onConfirm: (pickText: string) => void; disabled: boolean };

/**
 * One accordion per provider with its slots as buttons (ADR-007): tap a slot, then
 * Confirm sends that slot's server-built `pickText` as an ordinary chat message.
 */
export const OptionBlocks = ({ blocks, onConfirm, disabled }: Props) => {
  const [open, setOpen] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null); // a pickText

  return (
    <div className="mt-2 space-y-1">
      {blocks.map((block) => {
        const expanded = open === block.provider.id;
        return (
          <div key={block.provider.id} className="rounded border border-neutral-300 bg-white">
            <button
              className="flex w-full justify-between px-2 py-1 text-left text-sm"
              aria-expanded={expanded}
              onClick={() => setOpen(expanded ? null : block.provider.id)}
            >
              <span>{block.provider.name}</span>
              <span className="text-neutral-500">
                {rupees(block.provider.price)} · ★ {block.provider.rating}
              </span>
            </button>
            {expanded && (
              <div className="flex flex-wrap gap-1 px-2 pb-2">
                {block.slots.map((slot) => (
                  <button
                    key={slot.start}
                    aria-pressed={selected === slot.pickText}
                    className={`rounded border px-2 py-0.5 text-xs ${selected === slot.pickText ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-300"}`}
                    onClick={() => setSelected(slot.pickText)}
                  >
                    {slot.label}
                  </button>
                ))}
                {/* FR-6: details open via a normal chat message the model reads as a details ask */}
                <button
                  className="rounded border border-neutral-300 px-2 py-0.5 text-xs text-neutral-600"
                  onClick={() => onConfirm(`Tell me more about ${block.provider.name}`)}
                >
                  Details
                </button>
              </div>
            )}
          </div>
        );
      })}
      <button
        className="rounded bg-neutral-900 px-3 py-1 text-xs text-white disabled:opacity-50"
        disabled={disabled || selected === null}
        onClick={() => selected && onConfirm(selected)}
      >
        Confirm
      </button>
    </div>
  );
};
