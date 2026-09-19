import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowUp, Check, Loader2, Mail, MailOpen, Paperclip, RefreshCw, Search, Star, Trash2, X } from 'lucide-react';
import type { ParsedFilters, SearchResult } from '@inbox/shared';
import { useQueryClient } from '@tanstack/react-query';
import type { BatchAction, MessageSummary } from '@inbox/shared';
import { qk, useAccounts, useBatchMessages, useMessages, usePatchMessage } from '@/lib/queries';
import { cn, colorVar, displayName, formatListDate } from '@/lib/utils';
import { EmptyState } from '@/components/primitives';
import { Button, IconButton } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/input';
import { Tooltip } from '@/components/ui/overlay';

const ROW_H = 68;
const SWIPE_TRIGGER = 96; // px

export interface MessageListProps {
  scope: string;
  title: string;
  selectedId: number | null;
  onSelect: (id: number) => void;
  /** Called after the currently open message was deleted so the parent can move on. */
  onDeletedSelected: (nextId: number | null) => void;
  /** Increments when new mail arrived while the user was scrolled down. */
  pendingNew: number;
  onConsumePending: () => void;
  /** Active search string ('' = normal inbox). */
  search: string;
  onSearchChange: (q: string) => void;
}

export interface MessageListHandle {
  deleteIds: (ids: number[]) => void;
}

export const MessageList = forwardRef<MessageListHandle, MessageListProps>(function MessageList({ scope, title, selectedId, onSelect, onDeletedSelected, pendingNew, onConsumePending, search, onSearchChange }, ref) {
  const q = useMessages(scope, search);
  const parsed = (q.data?.pages[0] as SearchResult | undefined)?.parsedFilters;
  const qc = useQueryClient();
  const patch = usePatchMessage();
  const batch = useBatchMessages();
  const { data: accounts } = useAccounts();
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const parentRef = useRef<HTMLDivElement>(null);
  const [atTop, setAtTop] = useState(true);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const lastCheckedRef = useRef<number | null>(null);
  const unified = scope === 'unified';

  // Drop selections that no longer exist (deleted / scope change)
  useEffect(() => {
    setChecked((prev) => {
      if (!prev.size) return prev;
      const ids = new Set(items.map((m) => m.id));
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [items]);
  useEffect(() => setChecked(new Set()), [scope]);

  const virtualizer = useVirtualizer({
    count: items.length + (q.hasNextPage ? 1 : 0),
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_H,
    overscan: 8,
  });

  const vItems = virtualizer.getVirtualItems();
  const lastIndex = vItems[vItems.length - 1]?.index ?? -1;
  useEffect(() => {
    if (lastIndex >= items.length - 8 && q.hasNextPage && !q.isFetchingNextPage) q.fetchNextPage();
  }, [lastIndex, items.length, q]);

  useEffect(() => {
    if (pendingNew && atTop) {
      qc.invalidateQueries({ queryKey: qk.messages(scope) });
      onConsumePending();
    }
  }, [pendingNew, atTop, qc, scope, onConsumePending]);

  const showNew = () => {
    qc.invalidateQueries({ queryKey: qk.messages(scope) });
    onConsumePending();
    parentRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  /** Delete a set of ids; if the open message is among them, tell the parent where to go next. */
  const deleteIds = useCallback(
    (ids: number[]) => {
      if (!ids.length) return;
      const set = new Set(ids);
      if (selectedId !== null && set.has(selectedId)) {
        const idx = items.findIndex((m) => m.id === selectedId);
        const next = items.slice(idx + 1).find((m) => !set.has(m.id)) ?? items.slice(0, idx).reverse().find((m) => !set.has(m.id)) ?? null;
        onDeletedSelected(next?.id ?? null);
      }
      batch.mutate({ ids, action: 'delete' });
      setChecked(new Set());
    },
    [items, selectedId, onDeletedSelected, batch],
  );

  useImperativeHandle(ref, () => ({ deleteIds }), [deleteIds]);

  const runBatch = (action: BatchAction) => {
    const ids = [...checked];
    if (action === 'delete') return deleteIds(ids);
    batch.mutate({ ids, action });
    setChecked(new Set());
  };

  const toggleCheck = (id: number, shift: boolean) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (shift && lastCheckedRef.current !== null) {
        const a = items.findIndex((m) => m.id === lastCheckedRef.current);
        const b = items.findIndex((m) => m.id === id);
        if (a !== -1 && b !== -1) {
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(items[i]!.id);
          return next;
        }
      }
      if (next.has(id)) next.delete(id);
      else next.add(id);
      lastCheckedRef.current = id;
      return next;
    });
  };

  // Keyboard
  const selectRelative = useCallback(
    (delta: number) => {
      if (!items.length) return;
      const idx = items.findIndex((m) => m.id === selectedId);
      const next = Math.min(items.length - 1, Math.max(0, (idx === -1 ? (delta > 0 ? -1 : items.length) : idx) + delta));
      const m = items[next];
      if (m) {
        onSelect(m.id);
        virtualizer.scrollToIndex(next, { align: 'auto' });
      }
    },
    [items, selectedId, onSelect, virtualizer],
  );
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); selectRelative(1); return; }
      if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); selectRelative(-1); return; }
      if (e.key === 'x' && selectedId !== null) { e.preventDefault(); toggleCheck(selectedId, false); return; }
      if (checked.size && (e.key === '#' || e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); runBatch('delete'); return; }
      if (selectedId === null) return;
      const m = items.find((x) => x.id === selectedId);
      if (!m) return;
      if (e.key === 'u') { e.preventDefault(); patch.mutate({ id: m.id, patch: { seen: !m.seen } }); }
      if (e.key === 's') { e.preventDefault(); patch.mutate({ id: m.id, patch: { flagged: !m.flagged } }); }
      if (e.key === '#' || e.key === 'Delete') { e.preventDefault(); deleteIds([m.id]); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectRelative, selectedId, items, patch, checked, deleteIds]);

  const syncState = useMemo(() => {
    const list = accounts?.filter((a) => a.enabled && (unified || `account:${a.id}` === scope)) ?? [];
    if (list.some((a) => a.status === 'syncing')) return '同步中…';
    const last = Math.max(0, ...list.map((a) => a.lastSyncAt ?? 0));
    return last ? `${formatListDate(last)} 已同步` : '';
  }, [accounts, scope, unified]);

  const checkedItems = items.filter((m) => checked.has(m.id));
  const allChecked = checkedItems.length > 0 && checkedItems.every((m) => m.seen);

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="px-3 pt-3">
        <SearchBox value={search} onChange={onSearchChange} parsed={search ? parsed : undefined} />
        {checked.size ? (
          <div className="flex h-10 items-center gap-1 px-1 pb-1 pt-2 animate-fade-in">
            <span className="mr-1 text-[13px] font-medium tnum">已选 {checked.size}</span>
            <Tooltip content={allChecked ? '标为未读' : '标为已读'}>
              <IconButton label="已读/未读" onClick={() => runBatch(allChecked ? 'unseen' : 'seen')}>{allChecked ? <Mail className="h-4 w-4" /> : <MailOpen className="h-4 w-4" />}</IconButton>
            </Tooltip>
            <Tooltip content="星标">
              <IconButton label="星标" onClick={() => runBatch(checkedItems.every((m) => m.flagged) ? 'unflag' : 'flag')}><Star className="h-4 w-4" /></IconButton>
            </Tooltip>
            <Tooltip content="删除">
              <IconButton label="删除" className="text-danger hover:bg-danger-soft" onClick={() => runBatch('delete')}><Trash2 className="h-4 w-4" /></IconButton>
            </Tooltip>
            <div className="flex-1" />
            <Button variant="ghost" size="sm" onClick={() => setChecked(new Set())}><X className="h-3.5 w-3.5" /> 取消</Button>
          </div>
        ) : (
          <div className="flex h-10 items-center justify-between px-1 pb-1 pt-2">
            <h2 className="truncate text-[15px] font-semibold tracking-tight">{search ? `搜索结果${items.length ? ` · ${items.length}${q.hasNextPage ? '+' : ''} 封` : ''}` : title}</h2>
            <div className="flex items-center gap-1 text-[12px] text-muted">
              <span>{syncState}</span>
              <Tooltip content="刷新">
                <IconButton label="刷新" className="h-6 w-6" onClick={() => q.refetch()}>
                  <RefreshCw className={cn('h-3.5 w-3.5', q.isFetching && 'animate-spin')} />
                </IconButton>
              </Tooltip>
            </div>
          </div>
        )}
      </div>

      <div className="relative min-h-0 flex-1">
        {pendingNew > 0 && !atTop && !search ? (
          <button onClick={showNew} className="absolute left-1/2 top-2 z-10 flex h-8 items-center gap-1.5 rounded-full bg-accent-soft px-3.5 text-[12.5px] font-medium text-accent shadow-md animate-slide-down hover:brightness-95">
            <ArrowUp className="h-3.5 w-3.5" /> {pendingNew} 封新邮件
          </button>
        ) : null}

        {q.isLoading ? (
          <div className="px-2 pt-1">{Array.from({ length: 8 }).map((_, i) => <RowSkeleton key={i} />)}</div>
        ) : q.isError ? (
          <EmptyState title="加载失败" description={(q.error as Error).message} />
        ) : items.length === 0 ? (
          search ? <EmptyState icon={Search} title="没有匹配的邮件" description="试试换个关键词，或用 from: / has:attachment / is:unread 过滤" /> : <EmptyState title={scope.startsWith('folder:') ? '这个文件夹是空的' : '收件箱空空如也'} description={unified ? '所有账户的新邮件都会出现在这里' : scope.startsWith('folder:') ? '只同步最近 30 天（可在账户设置里调整）' : '这个账户暂时没有邮件'} />
        ) : (
          <div ref={parentRef} className="h-full overflow-y-auto px-2 pb-2" onScroll={(e) => setAtTop((e.target as HTMLDivElement).scrollTop < 40)}>
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {vItems.map((v) => {
                const m = items[v.index];
                return (
                  <div key={v.key} data-index={v.index} className="absolute left-0 top-0 w-full" style={{ height: v.size, transform: `translateY(${v.start}px)` }}>
                    {m ? (
                      <MessageRow
                        m={m}
                        selected={m.id === selectedId}
                        checked={checked.has(m.id)}
                        selectionMode={checked.size > 0}
                        showAccount={unified}
                        onSelect={() => onSelect(m.id)}
                        onCheck={(shift) => toggleCheck(m.id, shift)}
                        onPatch={(p) => patch.mutate({ id: m.id, patch: p })}
                        onDelete={() => deleteIds([m.id])}
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center text-muted"><Loader2 className="h-4 w-4 animate-spin" /></div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

const CHIP_LABEL: Record<string, (v: unknown) => string> = {
  from: (v) => `发件人：${v}`,
  hasAttachment: () => '有附件',
  unread: () => '未读',
  starred: () => '星标',
  account: (v) => `账户：${v}`,
};
const CHIP_TOKEN: Record<string, RegExp> = {
  from: /\s*from:("[^"]*"|\S+)/i,
  hasAttachment: /\s*has:(attachment|附件)/i,
  unread: /\s*is:(unread|未读)/i,
  starred: /\s*is:(starred|flagged|星标)/i,
  account: /\s*(account|in):("[^"]*"|\S+)/i,
};

function SearchBox({ value, onChange, parsed }: { value: string; onChange: (q: string) => void; parsed?: ParsedFilters }) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (draft.trim() === value) return;
    const t = setTimeout(() => onChange(draft.trim()), 300);
    return () => clearTimeout(t);
  }, [draft, value, onChange]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
      if ((e.key === '/' && !typing) || (e.key === 'k' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        ref.current?.focus();
        ref.current?.select();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  const chips = parsed ? (Object.keys(CHIP_LABEL) as (keyof ParsedFilters)[]).filter((k) => parsed[k]) : [];
  const removeChip = (k: string) => {
    const next = value.replace(CHIP_TOKEN[k]!, '').trim();
    setDraft(next);
    onChange(next);
  };
  return (
    <div>
      <div className={cn('flex h-9 items-center gap-2 rounded-[8px] bg-inset px-3 text-muted transition-shadow focus-within:ring-2 focus-within:ring-accent/25', value && 'ring-1 ring-accent/30')}>
        <Search className="h-4 w-4 shrink-0" />
        <input
          ref={ref}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.stopPropagation(); setDraft(''); onChange(''); ref.current?.blur(); }
            if (e.key === 'Enter') onChange(draft.trim());
          }}
          className="h-full min-w-0 flex-1 bg-transparent text-[13.5px] text-primary placeholder:text-muted focus:outline-none"
          placeholder="搜索邮件  ( / )"
          aria-label="搜索邮件"
        />
        {draft ? (
          <button onClick={() => { setDraft(''); onChange(''); }} className="rounded p-0.5 hover:bg-hover hover:text-primary" aria-label="清除搜索"><X className="h-3.5 w-3.5" /></button>
        ) : null}
      </div>
      {chips.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5 px-0.5">
          {chips.map((k) => (
            <span key={k} className="inline-flex h-6 items-center gap-1 rounded-full bg-accent-soft pl-2.5 pr-1 text-[12px] font-medium text-accent">
              {CHIP_LABEL[k]!(parsed![k])}
              <button onClick={() => removeChip(k)} className="rounded-full p-0.5 hover:bg-accent/15" aria-label="移除过滤"><X className="h-3 w-3" /></button>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RowSkeleton() {
  return (
    <div className="flex h-[68px] flex-col justify-center gap-2 px-4">
      <div className="flex justify-between"><Skeleton className="h-3.5 w-28" /><Skeleton className="h-3 w-10" /></div>
      <Skeleton className="h-3.5 w-[85%]" />
    </div>
  );
}

interface RowProps {
  m: MessageSummary;
  selected: boolean;
  checked: boolean;
  selectionMode: boolean;
  showAccount: boolean;
  onSelect: () => void;
  onCheck: (shift: boolean) => void;
  onPatch: (p: { seen?: boolean; flagged?: boolean }) => void;
  onDelete: () => void;
}

function MessageRow({ m, selected, checked, selectionMode, showAccount, onSelect, onCheck, onPatch, onDelete }: RowProps) {
  const unread = !m.seen;
  const [dx, setDx] = useState(0);
  const touch = useRef<{ x: number; y: number; active: boolean } | null>(null);

  // Touch swipe: right → toggle read, left → delete
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    touch.current = { x: e.clientX, y: e.clientY, active: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const t = touch.current;
    if (!t || e.pointerType !== 'touch') return;
    const ddx = e.clientX - t.x;
    const ddy = e.clientY - t.y;
    if (!t.active) {
      if (Math.abs(ddx) < 12 || Math.abs(ddy) > Math.abs(ddx)) return;
      t.active = true;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    setDx(Math.max(-160, Math.min(160, ddx)));
  };
  const onPointerEnd = (e: React.PointerEvent) => {
    const t = touch.current;
    touch.current = null;
    if (!t?.active) return;
    e.preventDefault();
    if (dx <= -SWIPE_TRIGGER) onDelete();
    else if (dx >= SWIPE_TRIGGER) onPatch({ seen: !m.seen });
    setDx(0);
  };
  const swiping = dx !== 0;

  return (
    <div className="relative h-[68px] overflow-hidden rounded-[6px]">
      {/* swipe backgrounds */}
      {swiping ? (
        <div className={cn('absolute inset-0 flex items-center px-5 text-white', dx > 0 ? 'justify-start bg-accent' : 'justify-end bg-danger')}>
          {dx > 0 ? (m.seen ? <Mail className="h-5 w-5" /> : <MailOpen className="h-5 w-5" />) : <Trash2 className="h-5 w-5" />}
        </div>
      ) : null}
      <div
        role="button"
        tabIndex={-1}
        onClick={(e) => (selectionMode ? onCheck(e.shiftKey) : onSelect())}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        style={{ transform: swiping ? `translateX(${dx}px)` : undefined, transition: swiping ? 'none' : 'transform 160ms var(--ease-out-quart)' }}
        className={cn(
          'group relative flex h-[68px] cursor-default select-none items-stretch rounded-[6px] px-2 transition-colors duration-100 touch-pan-y',
          checked ? 'bg-accent-soft' : selected ? 'bg-active' : 'bg-surface hover:bg-hover',
        )}
      >
        {showAccount ? <span aria-hidden className="absolute bottom-3 left-0 top-3 w-0.5 rounded-full" style={{ background: colorVar(m.accountColor) }} /> : null}

        {/* checkbox / unread dot */}
        <div className="flex w-6 shrink-0 items-center justify-center" onClick={(e) => { e.stopPropagation(); onCheck(e.shiftKey); }}>
          <span
            className={cn(
              'flex h-4 w-4 items-center justify-center rounded-[4px] border transition-all',
              checked ? 'border-accent bg-accent text-accent-fg' : 'border-strong bg-surface opacity-0 group-hover:opacity-100',
              selectionMode && 'opacity-100',
            )}
          >
            {checked ? <Check className="h-3 w-3" strokeWidth={3} /> : null}
          </span>
          {unread && !checked && !selectionMode ? <span className="absolute left-[11px] h-1.5 w-1.5 rounded-full bg-accent group-hover:opacity-0" /> : null}
        </div>

        <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 pr-2">
          <div className="flex items-baseline justify-between gap-3">
            <span className={cn('truncate text-[14px]', unread ? 'font-semibold text-primary' : 'font-medium text-secondary')}>{displayName(m.fromName, m.fromAddr)}</span>
            <span className="tnum shrink-0 text-[12px] text-muted group-hover:opacity-0">{formatListDate(m.internalDate)}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className={cn('truncate text-[13.5px]', unread ? 'font-medium text-primary' : 'text-secondary')}>
              {m.subject || '(无主题)'}
              {m.snippet ? <span className="font-normal text-muted"> · {m.snippet}</span> : null}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1 text-muted">
              {m.hasAttachments ? <Paperclip className="h-3.5 w-3.5" /> : null}
              {m.flagged ? <Star className="h-3.5 w-3.5 fill-c-amber text-c-amber" /> : null}
            </span>
          </div>
        </div>

        {!selectionMode ? (
          <div className="absolute right-2 top-2 hidden items-center gap-0.5 rounded-md bg-surface/90 shadow-sm backdrop-blur group-hover:flex" onClick={(e) => e.stopPropagation()}>
            <Tooltip content={m.seen ? '标为未读' : '标为已读'}>
              <IconButton label="已读/未读" className="h-6 w-6" onClick={() => onPatch({ seen: !m.seen })}>{m.seen ? <Mail className="h-3.5 w-3.5" /> : <MailOpen className="h-3.5 w-3.5" />}</IconButton>
            </Tooltip>
            <Tooltip content={m.flagged ? '取消星标' : '星标'}>
              <IconButton label="星标" className="h-6 w-6" onClick={() => onPatch({ flagged: !m.flagged })}><Star className={cn('h-3.5 w-3.5', m.flagged && 'fill-c-amber text-c-amber')} /></IconButton>
            </Tooltip>
            <Tooltip content="删除">
              <IconButton label="删除" className="h-6 w-6 hover:bg-danger-soft hover:text-danger" onClick={onDelete}><Trash2 className="h-3.5 w-3.5" /></IconButton>
            </Tooltip>
          </div>
        ) : null}
      </div>
    </div>
  );
}
