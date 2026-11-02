// Structured parts of an agent message (§ 2.4): built by the server from state, never
// by the model. The page renders them; it never re-derives slot times or prices.

export type OptionBlock = {
  provider: { id: string; name: string; rating: number; price: number };
  slots: { start: string; label: string; pickText: string }[];
};

export type OptionBlocksPart = { type: "option_blocks"; blocks: OptionBlock[] };

export type ApprovalCardPart = {
  type: "approval_card";
  approvalId: string;
  action: string;
  provider: { id: string; name: string };
  slot: string;
  slotLabel: string;
  price: number;
  status: string;
};

export const isOptionBlocks = (part: unknown): part is OptionBlocksPart =>
  (part as { type?: string } | null)?.type === "option_blocks";

export const isApprovalCard = (part: unknown): part is ApprovalCardPart =>
  (part as { type?: string } | null)?.type === "approval_card";

export const rupees = (n: number): string => `₹${n.toLocaleString("en-IN")}`;
