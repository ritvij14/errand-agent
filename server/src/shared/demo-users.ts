// Fixed demo users (2.3): the mock world seeds bookings for these ids, the auth
// module seeds the accounts themselves (same ids). Keep the ids stable — the seed
// data and evals reference them.
export type DemoUser = { id: string; username: string; password: string };

export const DEMO_USERS: DemoUser[] = [
  { id: "u-demo-alice", username: "alice", password: "demo-password-1" },
  { id: "u-demo-bob", username: "bob", password: "demo-password-2" },
  { id: "u-demo-charlie", username: "charlie", password: "demo-password-3" },
];