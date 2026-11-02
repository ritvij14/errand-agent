import { describe, expect, it } from "vitest";
import { createClock } from "../shared/clock.js";
import { readUserMessage } from "./model.js";
import { buildOptions, pickText, type OptionBlock } from "./options.js";
import type { TimeWindow } from "./time-window.js";

// Reading a pick (FR-9, ADR-007): the page sends the slot's pickText; people may type
// the provider name and a time. Fixed now: Mon 2026-11-02 09:15 IST.

const clock = createClock({ now: new Date("2026-11-02T03:45:00Z") });
const at = (day: string, hhmm: string) => `2026-11-${day}T${hhmm}:00+05:30`;
const anyTime: TimeWindow = { dateFrom: null, dateTo: null, earliest: null, latest: null };
const provider = (id: string, name: string, slots: string[]) => ({
  id,
  name,
  price: 900,
  rating: 4.5,
  attributes: {},
  slots,
});

const options = (): OptionBlock[] => {
  const result = buildOptions(
    [
      provider("p-deva", "Deva Pipe Care", [at("03", "09:00"), at("03", "10:00"), at("04", "10:00")]),
      provider("p-sai", "Sri Sai Plumbing Works", [at("03", "11:00")]),
    ],
    { timeWindow: anyTime, budget: undefined },
  );
  if (!result.ok) throw new Error("no options");
  return result.blocks;
};

const read = (text: string, shown: OptionBlock[] | undefined = options()) =>
  readUserMessage(text, clock, shown);

describe("pick text", () => {
  it("names the provider, the IST day and the time", () => {
    expect(pickText("Deva Pipe Care", at("03", "10:00"))).toBe("Book Deva Pipe Care on Tue 3 Nov at 10:00");
  });

  it("every slot's pickText reads back as exactly that provider and slot", async () => {
    for (const block of options()) {
      for (const slot of block.slots) {
        expect(await read(slot.pickText)).toEqual({
          kind: "pick",
          providerId: block.provider.id,
          slot: slot.start,
        });
      }
    }
  });
});

describe("typed picks", () => {
  it("provider name + a time that only one of its slots has → that slot", async () => {
    expect(await read("deva pipe care tomorrow at 9am")).toEqual({
      kind: "pick",
      providerId: "p-deva",
      slot: at("03", "09:00"),
    });
    expect(await read("Sri Sai Plumbing Works please")).toEqual({
      kind: "pick",
      providerId: "p-sai",
      slot: at("03", "11:00"),
    });
  });

  it("a provider with several matching slots, or 'the second one', is unclear — the agent asks which", async () => {
    expect(await read("Deva Pipe Care at 10")).toEqual({ kind: "pick_unclear" });
    expect(await read("the second one")).toEqual({ kind: "pick_unclear" });
  });

  it("with no options shown, 'the second one' is still a pick attempt (NOTHING_TO_PICK upstream)", async () => {
    expect(await read("the second one", undefined)).toEqual({ kind: "pick_unclear" });
  });

  it("a correction while options are shown is not mistaken for a pick", async () => {
    expect((await read("make the budget ₹900")).kind).toBe("correction");
  });
});
