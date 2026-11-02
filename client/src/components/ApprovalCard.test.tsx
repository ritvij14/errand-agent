import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "./ApprovalCard.js";
import type { ApprovalCardPart } from "../shared/parts.js";

const CARD: ApprovalCardPart = {
  type: "approval_card",
  approvalId: "a1",
  action: "book",
  provider: { id: "p1", name: "Deva Pipe Care" },
  slot: "2026-11-03T09:00:00+05:30",
  slotLabel: "Tue 3 Nov at 09:00",
  price: 1350,
  status: "pending",
};

const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("ApprovalCard", () => {
  it("shows the part's provider, slot and price — what the user is approving", () => {
    render(<ApprovalCard card={CARD} onDecide={vi.fn()} disabled={false} />);
    const card = screen.getByRole("group", { name: /approval/i });
    expect(card.textContent).toContain("Deva Pipe Care");
    expect(card.textContent).toContain("Tue 3 Nov at 09:00");
    expect(card.textContent).toContain("₹1,350");
  });

  it("Approve and Decline report the decision for this card", async () => {
    const user = userEvent.setup();
    const onDecide = vi.fn();
    render(<ApprovalCard card={CARD} onDecide={onDecide} disabled={false} />);
    await user.click(button("Approve"));
    await user.click(button("Decline"));
    expect(onDecide.mock.calls).toEqual([
      ["a1", "approve"],
      ["a1", "decline"],
    ]);
  });

  it("both buttons are disabled while a reply is pending", () => {
    render(<ApprovalCard card={CARD} onDecide={vi.fn()} disabled={true} />);
    expect(button("Approve").disabled).toBe(true);
    expect(button("Decline").disabled).toBe(true);
  });
});
