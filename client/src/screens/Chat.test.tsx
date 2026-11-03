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

const renderChat = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Chat />
    </QueryClientProvider>,
  );
  return userEvent.setup();
};

describe("Chat — no conversation open", () => {
  it("shows only a New conversation button in the chat area — no message box that can't be typed in", async () => {
    renderChat();
    await screen.findByRole("button", { name: "Plumber this week" });
    expect(screen.queryByPlaceholderText(/Find a plumber/)).toBeNull();
    expect(screen.getByRole("button", { name: "Start a new conversation" })).toBeTruthy();
  });

  it("starting a new conversation opens it, ready to type", async () => {
    mocked.createConversation.mockResolvedValue({
      id: "c2",
      title: "New conversation",
      createdAt: 0,
      updatedAt: 0,
      busy: false,
    });
    mocked.conversation.mockResolvedValue({ conversation: { id: "c2" }, messages: [], busy: false });
    const user = renderChat();
    await user.click(await screen.findByRole("button", { name: "Start a new conversation" }));
    const box = (await screen.findByPlaceholderText(/Find a plumber/)) as HTMLInputElement;
    expect(box.disabled).toBe(false);
    expect(mocked.conversation).toHaveBeenCalledWith("c2");
  });

  it("the sidebar's + New conversation also opens the conversation it made", async () => {
    mocked.createConversation.mockResolvedValue({
      id: "c2",
      title: "New conversation",
      createdAt: 0,
      updatedAt: 0,
      busy: false,
    });
    mocked.conversation.mockResolvedValue({ conversation: { id: "c2" }, messages: [], busy: false });
    const user = renderChat();
    await user.click(await screen.findByRole("button", { name: "+ New conversation" }));
    await screen.findByPlaceholderText(/Find a plumber/);
    expect(mocked.conversation).toHaveBeenCalledWith("c2");
  });
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
  it("switching conversations shows the new conversation's latest run, not a trace picked in the old one", async () => {
    mocked.conversations.mockResolvedValue([
      { id: "c1", title: "Plumber this week", createdAt: 0, updatedAt: 0, busy: false },
      { id: "c2", title: "Electrician", createdAt: 0, updatedAt: 0, busy: false },
    ]);
    mocked.conversation.mockImplementation(async (id: string) =>
      id === "c1"
        ? { conversation: { id: "c1" }, messages: MESSAGES, busy: false }
        : {
            conversation: { id: "c2" },
            messages: [{ id: "m9", role: "agent", text: "hi", parts: [], runId: "r2" }],
            busy: false,
          },
    );
    const user = await openConversation();
    await user.click(screen.getAllByRole("button", { name: "trace" }).at(-1)!);
    await user.click(button("Electrician"));
    await waitFor(() => expect(mocked.trace).toHaveBeenLastCalledWith("r2"));
  });

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
      expect(mocked.sendMessage).toHaveBeenCalledWith("c1", PICK, expect.any(String), undefined, undefined),
    );
  });

  it("a typed yes carries the id of the card on screen (§ 2.5.5 rule 1)", async () => {
    const user = await openConversation();
    await user.type(screen.getByPlaceholderText(/Find a plumber/), "yes{Enter}");
    await waitFor(() =>
      expect(mocked.sendMessage).toHaveBeenCalledWith("c1", "yes", expect.any(String), "a1", undefined),
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

describe("Chat — memory card (2.5.8: confirm an inferred fact)", () => {
  const MEMORY_MESSAGES = [
    {
      id: "m1",
      role: "agent",
      text: "Your last two bookings were in Jayanagar — use Jayanagar again?",
      runId: "r1",
      parts: [
        {
          type: "memory_confirm",
          factId: "f1",
          key: "area",
          label: "Jayanagar",
          ask: "Your last two bookings were in Jayanagar — use Jayanagar again?",
        },
      ],
    },
  ];
  const openMemoryCard = async () => {
    mocked.conversation.mockResolvedValue({
      conversation: { id: "c1" },
      messages: MEMORY_MESSAGES,
      busy: false,
    });
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
    await screen.findByRole("button", { name: "Keep" });
    return user;
  };

  it("Keep answers yes for exactly that fact", async () => {
    const user = await openMemoryCard();
    await user.click(button("Keep"));
    await waitFor(() =>
      expect(mocked.sendMessage).toHaveBeenCalledWith("c1", "yes", expect.any(String), undefined, "f1"),
    );
  });

  it("Don't keep answers no for exactly that fact", async () => {
    const user = await openMemoryCard();
    await user.click(button("Don't keep"));
    await waitFor(() =>
      expect(mocked.sendMessage).toHaveBeenCalledWith("c1", "no", expect.any(String), undefined, "f1"),
    );
  });

  it("a typed yes with the memory card newest on screen carries that fact's id", async () => {
    const user = await openMemoryCard();
    await user.type(screen.getByPlaceholderText(/Find a plumber/), "yes{Enter}");
    await waitFor(() =>
      expect(mocked.sendMessage).toHaveBeenCalledWith("c1", "yes", expect.any(String), undefined, "f1"),
    );
  });

  it("Keep and Don't keep are disabled while a reply is pending", async () => {
    mocked.sendMessage.mockReturnValue(new Promise(() => undefined)); // never answers
    const user = await openMemoryCard();
    await user.click(button("Keep"));
    await waitFor(() => expect(button("Keep").disabled).toBe(true));
    expect(button("Don't keep").disabled).toBe(true);
  });
});
