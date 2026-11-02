import type { ApprovalRecord } from "./approval.repo.js";

/** The approval_card part, drawn only from the record: the card shows exactly what gets checked. */
export const approvalCardPart = (record: ApprovalRecord, providerName: string): Record<string, unknown> => ({
  type: "approval_card",
  approvalId: record.id,
  action: record.action,
  provider: { id: record.provider_id, name: providerName },
  slot: record.slot,
  price: record.price,
  ...(record.booking_id ? { bookingId: record.booking_id } : {}),
  status: record.status,
});
