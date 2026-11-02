import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SignIn } from "./SignIn.js";
import { ApiError, api } from "../shared/api-client.js";

vi.mock("../shared/api-client.js", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    code?: string;
    details?: Record<string, string>;
    constructor(status: number, body: { error?: string; code?: string; details?: Record<string, string> }) {
      super(body.error ?? "error");
      this.status = status;
      this.code = body.code;
      this.details = body.details;
    }
  },
  api: {
    signIn: vi.fn(),
    signUp: vi.fn(),
  },
}));

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

async function submit(username: string, password: string) {
  const user = userEvent.setup();
  render(<SignIn />, { wrapper });
  await user.type(screen.getByLabelText("Username"), username);
  await user.type(screen.getByLabelText("Password"), password);
  await user.click(screen.getByText("Sign in"));
}

describe("SignIn", () => {
  it("shows inline field errors from the server's details", async () => {
    (api.signIn as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ApiError(400, { code: "VALIDATION_ERROR", details: { password: "must be 8–64 characters" } }),
    );
    await submit("tester", "short");
    await waitFor(() => expect(screen.getByText("must be 8–64 characters")).toBeTruthy());
  });

  it("submits the typed credentials to signIn", async () => {
    (api.signIn as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ user: { id: "u1", username: "tester" } });
    await submit("tester", "password123");
    await waitFor(() => expect(api.signIn).toHaveBeenCalledWith("tester", "password123"));
  });

  it("disables the submit button while the request is pending", async () => {
    let resolve!: (v: { user: { id: string } }) => void;
    (api.signIn as ReturnType<typeof vi.fn>).mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const promise = submit("tester", "password123");
    await waitFor(() => expect((screen.getByText("Signing in…") as HTMLButtonElement).disabled).toBe(true));
    resolve({ user: { id: "u1" } });
    await promise;
    await waitFor(() => expect(screen.getByText("Sign in")).toBeTruthy());
  });
});