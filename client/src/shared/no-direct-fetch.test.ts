import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Convention (AGENTS.md): client data fetching goes through the API client module —
// components never call fetch. Enforced structurally here: only
// src/shared/api-client.ts may contain a fetch call.
describe("module boundary: components never call fetch directly", () => {
  it("only src/shared/api-client.ts mentions fetch(", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(tsx?|jsx?)$/.test(entry) || entry.includes("api-client") || entry.includes(".test.")) continue;
        if (/\bfetch\(/.test(readFileSync(full, "utf8"))) offenders.push(full);
      }
    };
    walk(import.meta.dirname!);
    expect(offenders).toEqual([]);
  });
});