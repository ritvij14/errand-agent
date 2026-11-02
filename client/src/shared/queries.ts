import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { randomUUID } from "../shared/uuid.js";
import { api } from "../shared/api-client.js";

// All client data fetching lives here (TanStack Query); components stay presentational.

export const useMe = () => useQuery({ queryKey: ["me"], queryFn: () => api.me(), retry: false, staleTime: 10_000 });

export const useConversations = (enabled: boolean) =>
  useQuery({ queryKey: ["conversations"], queryFn: () => api.conversations(), enabled, refetchInterval: 5000 });

export const useConversation = (id: string | null, enabled: boolean) =>
  useQuery({ queryKey: ["conversation", id], queryFn: () => api.conversation(id!), enabled });

export const useCreateConversation = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.createConversation(),
    onSuccess: () => client.invalidateQueries({ queryKey: ["conversations"] }),
  });
};

const refreshConversation = (client: ReturnType<typeof useQueryClient>, id: string) => {
  client.invalidateQueries({ queryKey: ["conversation", id] });
  client.invalidateQueries({ queryKey: ["conversations"] });
};

export const useSendMessage = (id: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ text, approvalId }: { text: string; approvalId?: string }) => api.sendMessage(id, text, randomUUID(), approvalId),
    onSuccess: () => refreshConversation(client, id),
  });
};

/** The Approve / Decline buttons (§ 2.5.5): a run of its own, so the conversation reloads after. */
export const useDecideApproval = (conversationId: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ approvalId, decision }: { approvalId: string; decision: "approve" | "decline" }) => api.decideApproval(approvalId, decision),
    onSuccess: () => refreshConversation(client, conversationId),
  });
};

export const useSignIn = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ username, password, mode }: { username: string; password: string; mode: "signin" | "signup" }) =>
      mode === "signin" ? api.signIn(username, password) : api.signUp(username, password),
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