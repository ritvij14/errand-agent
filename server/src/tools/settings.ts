// App vs eval settings (2.5.4): all knobs in one object. Evals override so they run
// fast and test exactly what they claim; app/demo defaults per the design table.
export type MockSettings = {
  holdExpiryMs: number;
  priceDiffProb: number; // ~20% of holds quote a different price
  priceDiffMax: number; // by up to ±15%
  okProb: number; // book
  slotTakenProb: number;
  timeoutProb: number; // book timeout; half of timeouts actually booked
  timeoutBookedProb: number;
  timeoutPauseMs: number; // clock pause before a timeout returns
  slotConflictProb: number; // reschedule
  retryWaitsMs: number[]; // between retries: 0.5 s, then 1 s (NFR-2)
};

export const createMockSettings = (): MockSettings => ({
  holdExpiryMs: 10 * 60 * 1000,
  priceDiffProb: 0.2,
  priceDiffMax: 0.15,
  okProb: 0.7,
  slotTakenProb: 0.15,
  timeoutProb: 0.15,
  timeoutBookedProb: 0.5,
  timeoutPauseMs: 10_000,
  slotConflictProb: 0.1,
  retryWaitsMs: [500, 1000],
});

export const DEFAULT_SEED = "errand-agent-v1";