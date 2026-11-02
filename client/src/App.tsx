import { useMe } from "./shared/queries.js";
import { SignIn } from "./screens/SignIn.js";
import { Chat } from "./screens/Chat.js";

// The app: unauthenticated → sign-in screen; else the chat page (§ 2.4).
export function App() {
  const me = useMe();
  if (me.isLoading) return <p className="p-8 text-sm text-neutral-500">Loading…</p>;
  if (me.data === undefined || me.data === null) return <SignIn />;
  return <Chat />;
}
