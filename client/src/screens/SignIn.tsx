import { useState } from "react";
import { useSignIn } from "../shared/queries.js";
import type { ApiError } from "../shared/api-client.js";

// Sign-in / sign-up screen with inline field errors from the server's details (FR-1).
export function SignIn() {
  const signInMut = useSignIn();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    signInMut.mutate({ username, password, mode });
  };

  const fieldError = (name: string): string | null => {
    const error = signInMut.error as ApiError | null;
    if (!error) return null;
    return error.details?.[name] ?? (error.code ? error.message : null);
  };

  const busy = signInMut.isPending;

  return (
    <form onSubmit={submit} className="mx-auto mt-32 flex max-w-sm flex-col gap-3">
      <h1 className="text-lg font-semibold">errand-agent</h1>
      <p className="text-sm text-neutral-500">Book, reschedule and cancel home services — with your approval.</p>
      <label className="text-sm">
        Username
        <input className="mt-1 w-full rounded border border-neutral-300 px-2 py-1" value={username} onChange={(e) => setUsername(e.target.value)} />
      </label>
      {fieldError("username") && <p className="text-xs text-red-700">{fieldError("username")}</p>}
      <label className="text-sm">
        Password
        <input type="password" className="mt-1 w-full rounded border border-neutral-300 px-2 py-1" value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      {fieldError("password") && <p className="text-xs text-red-700">{fieldError("password")}</p>}
      <button type="submit" disabled={busy} className="rounded bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-50">
        {busy ? "Signing in…" : mode === "signin" ? "Sign in" : "Create account"}
      </button>
      <button type="button" className="text-xs text-neutral-500 underline" onClick={() => setMode(mode === "signin" ? "signup" : "signin")}>
        {mode === "signin" ? "New here? Create an account" : "Have an account? Sign in"}
      </button>
    </form>
  );
}