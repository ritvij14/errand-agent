import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Chat } from "./Chat.js";
import { api } from "../shared/api-client.js";

vi.mock("../shared/api-client.js", () => ({
  api: {
    conversations: vi.fn(),
    conversation: vi.fn(),
    createConversation: vi.fn(),
    sendMessage: vi.fn(),
    decideApproval: vi.fn(),
    signOut: vi.fn(),
    memory: vi.fn(),
    trace: vi.fn(),
  },
}));

const PICK = "Book Deva Pipe Care on Tue 3 Nov at 09:00";
const MESSAGES = [
  {
    id: "m1",
    role: "agent",
    text: "I found 1 option.",
    parts: [
      {
        type: "option_blocks",
        blocks: [
          {
            provider: { id: "p1", name: "Deva Pipe Care", rating: 4.6, price: 1200 },
            slots: [{ start: "2026-11-03T09:00:00+05:30", label: "Tue 3 Nov at 09:00", pickText: PICK }],
          },
        ],
      },
    ],
  },
  {
    id: "m2",
    role: "agent",
    text: "Here are the details — approve to book, or decline.",
    runId: "r1",
    parts: [
      {
        type: "approval_card",
        approvalId: "a1",
        action: "book",
        provider: { id: "p1", name: "Deva Pipe Care" },
        slot: "2026-11-03T09:00:00+05:30",
        slotLabel: "Tue 3 Nov at 09:00",
        price: 1200,
        status: "pending",
      },
    ],
  },
];

const mocked = api as unknown as Record<keyof typeof api, ReturnType<typeof vi.fn>>;
const TRACE_FIXTURE = {
  run: { id: "r1", outcome: "completed", modelCalls: 2, toolCalls: 1 },
  events: [{ seq: 1, type: "run_started", clockAt: 0, durationMs: null, data: { trigger: "message" } }],
};
const REPLY = {
  runId: "r1",
  outcome: "completed",
  message: { id: "m3", role: "agent", text: "ok", parts: [] },
};

const openConversation = async () => {
  const user = userEvent.setup();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Chat />
    </QueryClientProvider>,
  );
  await user.click(await screen.findByRole("button", { name: "Plumber this week" }));
  await screen.findByRole("button", { name: "Approve" });
  return user;
};

const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;

beforeEach(() => {
  vi.resetAllMocks();
  mocked.conversations.mockResolvedValue([
    { id: "c1", title: "Plumber this week", createdAt: 0, updatedAt: 0, busy: false },
  ]);
  mocked.conversation.mockResolvedValue({ conversation: { id: "c1" }, messages: MESSAGES, busy: false });
  mocked.sendMessage.mockResolvedValue(REPLY);
  mocked.decideApproval.mockResolvedValue(REPLY);
  mocked.trace.mockResolvedValue(TRACE_FIXTURE);
  mocked.memory.mockResolvedValue([]);
});

describe("Chat — refresh after a reply", () => {
  it("a chat message that saves a preference shows it in the memory panel without a reload", async () => {
    const user = await openConversation();
    expect(screen.queryByText(/you told me/)).toBeNull();
    mocked.memory.mockResolvedValue([
      {
        id: "f1",
        key: "area",
        service: null,
        value: "koramangala",
        source: "stated",
        status: "active",
        evidence: null,
      },
    ]);
    await user.type(screen.getByPlaceholderText(/Find a plumber/), "I live in Koramangala{Enter}");
    await screen.findByText(/you told me/);
  });

  it("the new reply's trace starts loading with the conversation reload, not after it", async () => {
    const user = await openConversation();
    mocked.conversation.mockReturnValue(new Promise(() => undefined)); // the reload never answers
    mocked.sendMessage.mockResolvedValue({ ...REPLY, runId: "r9" });
    await user.type(screen.getByPlaceholderText(/Find a plumber/), "hello{Enter}");
    await waitFor(() => expect(mocked.trace).toHaveBeenCalledWith("r9"));
  });
});

describe("Chat — trace panel (FR-13, U35)", () => {
  it("each agent reply has a trace link that switches the panel to that run", async () => {
    const user = await openConversation();
    await user.click(screen.getAllByRole("button", { name: "trace" }).at(-1)!);
    await screen.findByText(/run_started/);
    expect(mocked.trace).toHaveBeenCalledWith("r1");
  });
});

describe("Chat — booking parts (FR-9, FR-10, ADR-007)", () => {
  it("tap a slot + Confirm sends the pick as a chat message, without a card id", async () => {
    const user = await openConversation();
    await user.click(button(/Deva Pipe Care/));
    await user.click(button("Tue 3 Nov at 09:00"));
    await user.click(button("Confirm"));
    await waitFor(() =>
      expect(mocked.sendMessage).toHaveBeenCalledWith("c1", PICK, expect.any(String), undefined),
    );
  });

  it("a typed yes carries the id of the card on screen (§ 2.5.5 rule 1)", async () => {
    const user = await openConversation();
    await user.type(screen.getByPlaceholderText(/Find a plumber/), "yes{Enter}");
    await waitFor(() =>
      expect(mocked.sendMessage).toHaveBeenCalledWith("c1", "yes", expect.any(String), "a1"),
    );
  });

  it("Approve sends the decision for that card", async () => {
    const user = await openConversation();
    await user.click(button("Approve"));
    await waitFor(() => expect(mocked.decideApproval).toHaveBeenCalledWith("a1", "approve"));
  });

  it("while a reply is pending, Approve, Decline, Confirm and Send are all disabled", async () => {
    mocked.decideApproval.mockReturnValue(new Promise(() => undefined)); // never answers
    const user = await openConversation();
    await user.click(button("Approve"));
    await waitFor(() => expect(button("Approve").disabled).toBe(true));
    expect(button("Decline").disabled).toBe(true);
    expect(button("Confirm").disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Send|…/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
