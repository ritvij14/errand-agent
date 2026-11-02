// The browser can't generate a crypto UUID synchronously everywhere, but this is a
// localhost page: crypto.randomUUID exists in every modern browser. Fallback kept
// for the jsdom test environment.
const randomId = (): string => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `cm-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

export const randomUUID = randomId;