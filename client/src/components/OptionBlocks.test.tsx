import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OptionBlocks } from "./OptionBlocks.js";
import type { OptionBlock } from "../shared/parts.js";

const BLOCKS: OptionBlock[] = [
  {
    provider: { id: "p1", name: "Deva Pipe Care", rating: 4.6, price: 1200 },
    slots: [
      {
        start: "2026-11-03T09:00:00+05:30",
        label: "Tue 3 Nov at 09:00",
        pickText: "Book Deva Pipe Care on Tue 3 Nov at 09:00",
      },
      {
        start: "2026-11-03T10:00:00+05:30",
        label: "Tue 3 Nov at 10:00",
        pickText: "Book Deva Pipe Care on Tue 3 Nov at 10:00",
      },
    ],
  },
  {
    provider: { id: "p2", name: "Maruthi Plumbing Works", rating: 4.2, price: 985 },
    slots: [
      {
        start: "2026-11-04T08:00:00+05:30",
        label: "Wed 4 Nov at 08:00",
        pickText: "Book Maruthi Plumbing Works on Wed 4 Nov at 08:00",
      },
    ],
  },
];

const confirm = () => screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;

describe("OptionBlocks", () => {
  it("each provider is an accordion: its slots show when opened and hide when closed", async () => {
    const user = userEvent.setup();
    render(<OptionBlocks blocks={BLOCKS} onConfirm={vi.fn()} disabled={false} />);
    expect(screen.queryByRole("button", { name: "Tue 3 Nov at 09:00" })).toBeNull();
    await user.click(screen.getByRole("button", { name: /Deva Pipe Care/ }));
    expect(screen.getByRole("button", { name: "Tue 3 Nov at 09:00" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Deva Pipe Care/ }).getAttribute("aria-expanded")).toBe("true");
    await user.click(screen.getByRole("button", { name: /Deva Pipe Care/ }));
    expect(screen.queryByRole("button", { name: "Tue 3 Nov at 09:00" })).toBeNull();
  });

  it("shows each provider's price and rating on its header", () => {
    render(<OptionBlocks blocks={BLOCKS} onConfirm={vi.fn()} disabled={false} />);
    const header = screen.getByRole("button", { name: /Maruthi Plumbing Works/ });
    expect(header.textContent).toContain("₹985");
    expect(header.textContent).toContain("4.2");
  });

  it("Confirm stays disabled until a slot is tapped", async () => {
    const user = userEvent.setup();
    render(<OptionBlocks blocks={BLOCKS} onConfirm={vi.fn()} disabled={false} />);
    expect(confirm().disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: /Deva Pipe Care/ }));
    await user.click(screen.getByRole("button", { name: "Tue 3 Nov at 10:00" }));
    expect(confirm().disabled).toBe(false);
  });

  it("tap a slot, then Confirm, sends that slot's exact pick message (ADR-007)", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<OptionBlocks blocks={BLOCKS} onConfirm={onConfirm} disabled={false} />);
    await user.click(screen.getByRole("button", { name: /Maruthi Plumbing Works/ }));
    await user.click(screen.getByRole("button", { name: "Wed 4 Nov at 08:00" }));
    await user.click(confirm());
    expect(onConfirm).toHaveBeenCalledWith("Book Maruthi Plumbing Works on Wed 4 Nov at 08:00");
  });

  it("only one slot is selected at a time — the last one tapped", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<OptionBlocks blocks={BLOCKS} onConfirm={onConfirm} disabled={false} />);
    await user.click(screen.getByRole("button", { name: /Deva Pipe Care/ }));
    await user.click(screen.getByRole("button", { name: "Tue 3 Nov at 09:00" }));
    await user.click(screen.getByRole("button", { name: "Tue 3 Nov at 10:00" }));
    expect(screen.getByRole("button", { name: "Tue 3 Nov at 09:00" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    await user.click(confirm());
    expect(onConfirm).toHaveBeenCalledWith("Book Deva Pipe Care on Tue 3 Nov at 10:00");
  });

  it("while a reply is pending, Confirm is disabled even with a slot selected", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<OptionBlocks blocks={BLOCKS} onConfirm={vi.fn()} disabled={false} />);
    await user.click(screen.getByRole("button", { name: /Deva Pipe Care/ }));
    await user.click(screen.getByRole("button", { name: "Tue 3 Nov at 09:00" }));
    rerender(<OptionBlocks blocks={BLOCKS} onConfirm={vi.fn()} disabled={true} />);
    expect(confirm().disabled).toBe(true);
  });

  it("Details sends 'Tell me more about {provider}'", async () => {
    const onConfirm = vi.fn();
    render(<OptionBlocks blocks={BLOCKS} onConfirm={onConfirm} disabled={false} />);
    const user = userEvent.setup();
    const accordion = screen.getAllByRole("button", { expanded: undefined })[0]!;
    await user.click(accordion);
    await user.click(screen.getByRole("button", { name: "Details" }));
    expect(onConfirm).toHaveBeenCalledWith("Tell me more about Deva Pipe Care");
  });
});
