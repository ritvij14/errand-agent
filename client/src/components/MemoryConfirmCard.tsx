import type { MemoryConfirmPart } from "../shared/parts.js";

type Props = {
  card: MemoryConfirmPart;
  onAnswer: (factId: string, answer: "yes" | "no") => void;
  disabled: boolean;
};

/** The question comes from the waiting fact's part; the buttons answer exactly that fact (2.5.8). */
export const MemoryConfirmCard = ({ card, onAnswer, disabled }: Props) => (
  <div
    role="group"
    aria-label="Remember this?"
    className="mt-2 rounded border border-neutral-300 bg-white p-2 text-sm"
  >
    <p className="text-xs text-neutral-500">
      Worked out from your past bookings — not used unless you keep it
    </p>
    <p className="font-medium">{card.label}</p>
    <div className="mt-2 flex gap-2">
      <button
        className="rounded bg-neutral-900 px-3 py-1 text-xs text-white disabled:opacity-50"
        disabled={disabled}
        onClick={() => onAnswer(card.factId, "yes")}
      >
        Keep
      </button>
      <button
        className="rounded border border-neutral-300 px-3 py-1 text-xs disabled:opacity-50"
        disabled={disabled}
        onClick={() => onAnswer(card.factId, "no")}
      >
        Don't keep
      </button>
    </div>
  </div>
);
