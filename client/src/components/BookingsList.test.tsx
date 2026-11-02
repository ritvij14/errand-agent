import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BookingsList } from "./BookingsList.js";
import type { BookingsListPart } from "../shared/parts.js";

const PART: BookingsListPart = {
  type: "bookings_list",
  bookings: [
    {
      id: "b1",
      providerName: "Chetan Electric Care",
      service: "electrician",
      area: "jayanagar",
      slot: "2026-11-03T08:00:00+05:30",
      slotLabel: "Tue 3 Nov at 08:00",
      price: 884,
      status: "booked",
    },
    {
      id: "b2",
      providerName: "Cool Air Services",
      service: "ac_servicing",
      area: "koramangala",
      slot: "2026-10-20T10:00:00+05:30",
      slotLabel: "Tue 20 Oct at 10:00",
      price: 1500,
      status: "completed",
    },
  ],
};

describe("BookingsList", () => {
  it("shows each booking's provider, time, price, status and id", () => {
    render(<BookingsList part={PART} />);
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Chetan Electric Care");
    expect(rows[0]!.textContent).toContain("Tue 3 Nov at 08:00");
    expect(rows[0]!.textContent).toContain("₹884");
    expect(rows[0]!.textContent).toContain("booked");
    expect(rows[0]!.textContent).toContain("b1");
    expect(rows[1]!.textContent).toContain("completed");
  });

  it("an empty list renders no rows", () => {
    render(<BookingsList part={{ type: "bookings_list", bookings: [] }} />);
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });
});
