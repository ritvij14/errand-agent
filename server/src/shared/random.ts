// Seeded randomness (NFR-4): every draw is computed from seed + tool + the call's
// own inputs + attempt number, so adding a call anywhere never shifts another
// call's outcome, and a retry can draw differently than its first attempt.

// xmur3 string hash, feeding a mulberry32 stream; one draw comes from one stream
// seeded by the full label, which keeps draws independent and reproducible.
const xmur3 = (str: string): (() => number) => {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
};

const mulberry32 = (a: number): (() => number) => {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export type RandomDrawInput = {
  seed: string;
  tool: string;
  inputs: string[];
  attempt: number;
};

export const randomDraw = (input: RandomDrawInput): number => {
  const label = [input.seed, input.tool, ...input.inputs, String(input.attempt)].join("|");
  const seedFn = xmur3(label);
  return mulberry32(seedFn())();
};