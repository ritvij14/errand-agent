import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { randomUUID } from "../shared/uuid.js";
import { api } from "../shared/api-client.js";

// All client data fetching lives here (TanStack Query); components stay presentational.

export const useMe = () =>
  useQuery({ queryKey: ["me"], queryFn: () => api.me(), retry: false, staleTime: 10_000 });

export const useConversations = (enabled: boolean) =>
  useQuery({
    queryKey: ["conversations"],
    queryFn: () => api.conversations(),
    enabled,
    refetchInterval: 5000,
  });

export const useConversation = (id: string | null, enabled: boolean) =>
  useQuery({ queryKey: ["conversation", id], queryFn: () => api.conversation(id!), enabled });

export const useCreateConversation = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.createConversation(),
    onSuccess: () => client.invalidateQueries({ queryKey: ["conversations"] }),
  });
};

/**
 * After a reply: reload the conversation, the list and memory (a chat message may save or
 * forget a preference), and start the reply's trace at the same time — the reply already
 * names its run, so the trace needn't wait for the conversation reload.
 */
const refreshConversation = (client: ReturnType<typeof useQueryClient>, id: string, runId?: string) => {
  client.invalidateQueries({ queryKey: ["conversation", id] });
  client.invalidateQueries({ queryKey: ["conversations"] });
  client.invalidateQueries({ queryKey: ["memory"] });
  if (runId) void client.prefetchQuery(traceQuery(runId));
};

export const useSendMessage = (id: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      text,
      approvalId,
      memoryFactId,
    }: {
      text: string;
      approvalId?: string;
      memoryFactId?: string;
    }) => api.sendMessage(id, text, randomUUID(), approvalId, memoryFactId),
    onSuccess: (reply) => refreshConversation(client, id, reply.runId),
  });
};

/** The Approve / Decline buttons (§ 2.5.5): a run of its own, so the conversation reloads after. */
export const useDecideApproval = (conversationId: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ approvalId, decision }: { approvalId: string; decision: "approve" | "decline" }) =>
      api.decideApproval(approvalId, decision),
    onSuccess: (reply) => refreshConversation(client, conversationId, reply.runId),
  });
};

export const useSignIn = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      username,
      password,
      mode,
    }: {
      username: string;
      password: string;
      mode: "signin" | "signup";
    }) => (mode === "signin" ? api.signIn(username, password) : api.signUp(username, password)),
    onSuccess: () => client.invalidateQueries({ queryKey: ["me"] }),
  });
};

export const useSignOut = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.signOut(),
    onSuccess: () => client.setQueryData(["me"], null),
  });
};

// ——— memory panel (FR-12, U34): the same memory code chat uses ———

export const useMemory = (enabled: boolean) =>
  useQuery({ queryKey: ["memory"], queryFn: () => api.memory(), enabled, staleTime: 5_000 });

const useMemoryMutation = <TArgs>(mutationFn: (args: TArgs) => Promise<unknown>) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["memory"] });
      client.invalidateQueries({ queryKey: ["conversation"] }); // a change may affect an open workflow (R6)
    },
  });
};

export const useEditMemory = () =>
  useMemoryMutation<{ id: string; value: string }>(({ id, value }) => api.updateMemory(id, value));
export const useConfirmMemory = () => useMemoryMutation<{ id: string }>(({ id }) => api.confirmMemory(id));
export const useRejectMemory = () => useMemoryMutation<{ id: string }>(({ id }) => api.rejectMemory(id));
export const useForgetMemory = () => useMemoryMutation<{ id: string }>(({ id }) => api.forgetMemory(id));

// ——— trace panel (FR-13, U35) ———

const traceQuery = (runId: string) => ({
  queryKey: ["trace", runId],
  queryFn: () => api.trace(runId),
  retry: false,
  staleTime: 60_000, // a finished run's trace doesn't change
});

export const useTrace = (runId: string | null, enabled: boolean) =>
  useQuery({ ...traceQuery(runId ?? ""), enabled: enabled && runId !== null });
