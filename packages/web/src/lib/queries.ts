import { useEffect } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { Account, BatchAction, MessageList, MessagePatch, MessageSummary } from '@inbox/shared';
import { api } from './api';

export const qk = {
  auth: ['auth'] as const,
  accounts: ['accounts'] as const,
  providers: ['providers'] as const,
  messages: (scope: string, search = '') => ['messages', scope, search] as const,
  message: (id: number) => ['message', id] as const,
  body: (id: number) => ['message', id, 'body'] as const,
};

export function useAuthStatus() {
  return useQuery({ queryKey: qk.auth, queryFn: api.auth.status, staleTime: 60_000 });
}

export function useAccounts() {
  return useQuery({ queryKey: qk.accounts, queryFn: api.accounts.list, staleTime: 15_000 });
}

export function useProviders() {
  return useQuery({ queryKey: qk.providers, queryFn: api.providers, staleTime: Infinity });
}

export function useMessages(scope: string, search = '') {
  return useInfiniteQuery({
    queryKey: qk.messages(scope, search),
    queryFn: ({ pageParam }) => (search ? api.search(search, scope, pageParam ?? undefined, 50) : api.messages.list(scope, pageParam ?? undefined, 50)),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 10_000,
  });
}

export function useMessage(id: number | null) {
  return useQuery({ queryKey: qk.message(id ?? 0), queryFn: () => api.messages.get(id!), enabled: id !== null, staleTime: 30_000 });
}

export function useMessageBody(id: number | null) {
  return useQuery({
    queryKey: qk.body(id ?? 0),
    queryFn: () => api.messages.body(id!),
    enabled: id !== null,
    staleTime: Infinity,
    retry: 1,
  });
}

/** Optimistically patch a message across every cached list page and its detail. */
export function usePatchMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: MessagePatch }) => api.messages.patch(id, patch),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: ['messages'] });
      const prevLists = qc.getQueriesData<InfiniteData<MessageList>>({ queryKey: ['messages'] });
      const prevDetail = qc.getQueryData<MessageSummary>(qk.message(id));
      const apply = (m: MessageSummary) => (m.id === id ? { ...m, ...patch } : m);
      for (const [key, data] of prevLists) {
        if (!data) continue;
        qc.setQueryData<InfiniteData<MessageList>>(key, {
          ...data,
          pages: data.pages.map((p) => ({ ...p, items: p.items.map(apply) })),
        });
      }
      if (prevDetail) qc.setQueryData(qk.message(id), { ...prevDetail, ...patch });
      // Unread badge in the sidebar
      const acc = qc.getQueryData<Account[]>(qk.accounts);
      if (acc && patch.seen !== undefined && prevDetail && (prevDetail.seen !== patch.seen)) {
        qc.setQueryData<Account[]>(
          qk.accounts,
          acc.map((a) => (a.id === prevDetail.accountId ? { ...a, unreadCount: Math.max(0, a.unreadCount + (patch.seen ? -1 : 1)) } : a)),
        );
      }
      return { prevLists, prevDetail };
    },
    onError: (err, { id }, ctx) => {
      for (const [key, data] of ctx?.prevLists ?? []) qc.setQueryData(key, data);
      if (ctx?.prevDetail) qc.setQueryData(qk.message(id), ctx.prevDetail);
      qc.invalidateQueries({ queryKey: qk.accounts });
      toast.error('标记失败，已恢复', { description: (err as Error).message });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: qk.accounts });
    },
  });
}

/** Batch action (incl. delete) with optimistic list updates. */
export function useBatchMessages() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ids, action }: { ids: number[]; action: BatchAction }) => api.messages.batch({ ids, action }),
    onMutate: async ({ ids, action }) => {
      await qc.cancelQueries({ queryKey: ['messages'] });
      const set = new Set(ids);
      const prevLists = qc.getQueriesData<InfiniteData<MessageList>>({ queryKey: ['messages'] });
      const patch: Partial<MessageSummary> =
        action === 'seen' ? { seen: true } : action === 'unseen' ? { seen: false } : action === 'flag' ? { flagged: true } : action === 'unflag' ? { flagged: false } : {};
      for (const [key, data] of prevLists) {
        if (!data) continue;
        qc.setQueryData<InfiniteData<MessageList>>(key, {
          ...data,
          pages: data.pages.map((p) => ({
            ...p,
            items: action === 'delete' ? p.items.filter((m) => !set.has(m.id)) : p.items.map((m) => (set.has(m.id) ? { ...m, ...patch } : m)),
          })),
        });
      }
      return { prevLists };
    },
    onError: (err, _v, ctx) => {
      for (const [key, data] of ctx?.prevLists ?? []) qc.setQueryData(key, data);
      toast.error('操作失败，已恢复', { description: (err as Error).message });
    },
    onSuccess: (_r, { ids, action }) => {
      if (action === 'delete') toast.success(ids.length > 1 ? `已删除 ${ids.length} 封邮件` : '已删除');
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: qk.accounts });
      qc.invalidateQueries({ queryKey: ['messages'] });
    },
  });
}

/** Subscribe to server-sent events and keep caches fresh. */
export function useServerEvents(onNewMail: (payload: { accountId: number; folderId: number; specialUse: string | null; count: number }) => void) {
  const qc = useQueryClient();
  useEffect(() => {
    const es = new EventSource('/api/events');
    const invalidateAccounts = () => qc.invalidateQueries({ queryKey: qk.accounts });
    es.addEventListener('account:status', invalidateAccounts);
    es.addEventListener('account:progress', invalidateAccounts);
    es.addEventListener('message:new', (e) => {
      const p = JSON.parse((e as MessageEvent).data) as { accountId: number; folderId: number; specialUse: string | null; count: number };
      invalidateAccounts();
      onNewMail(p);
    });
    es.addEventListener('message:flags', () => {
      qc.invalidateQueries({ queryKey: ['messages'] });
      invalidateAccounts();
    });
    es.addEventListener('message:removed', () => qc.invalidateQueries({ queryKey: ['messages'] }));
    es.addEventListener('message:op_failed', (e) => {
      const p = JSON.parse((e as MessageEvent).data) as { error: string };
      toast.error('同步标记到邮箱失败', { description: p.error });
      qc.invalidateQueries({ queryKey: ['messages'] });
    });
    es.onopen = () => qc.invalidateQueries({ queryKey: ['messages'] });
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qc]);
}
