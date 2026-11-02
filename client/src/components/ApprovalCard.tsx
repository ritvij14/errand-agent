import { rupees, type ApprovalCardPart } from "../shared/parts.js";

type Props = {
  card: ApprovalCardPart;
  onDecide: (approvalId: string, decision: "approve" | "decline") => void;
  disabled: boolean;
};

/** The details come from the approval record's part — exactly what the user approves (§ 2.5.5). */
export const ApprovalCard = ({ card, onDecide, disabled }: Props) => (
  <div
    role="group"
    aria-label="Booking approval"
    className="mt-2 rounded border border-neutral-300 bg-white p-2 text-sm"
  >
    <p className="font-medium">
      {card.action === "cancel" ? "Cancel" : card.action === "reschedule" ? "Move" : "Book"}{" "}
      {card.provider.name}
      {card.action === "reschedule" ? " to" : ""}
    </p>
    <p>{card.slotLabel}</p>
    <p>{rupees(card.price)}</p>
    <div className="mt-2 flex gap-2">
      <button
        className="rounded bg-neutral-900 px-3 py-1 text-xs text-white disabled:opacity-50"
        disabled={disabled}
        onClick={() => onDecide(card.approvalId, "approve")}
      >
        Approve
      </button>
      <button
        className="rounded border border-neutral-300 px-3 py-1 text-xs disabled:opacity-50"
        disabled={disabled}
        onClick={() => onDecide(card.approvalId, "decline")}
      >
        Decline
      </button>
    </div>
  </div>
);
