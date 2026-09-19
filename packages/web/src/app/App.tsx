import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Menu } from 'lucide-react';
import { toast } from 'sonner';
import { useAccounts, useAuthStatus, useBatchMessages, useServerEvents } from '@/lib/queries';
import { applyTheme, hydrateSettingsFromServer, useUi } from '@/lib/store';
import { cn } from '@/lib/utils';
import { IconButton } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/overlay';
import { AuthPage } from '@/features/auth/AuthPage';
import { Sidebar } from '@/features/inbox/Sidebar';
import { MessageList } from '@/features/inbox/MessageList';
import { MessageView } from '@/features/inbox/MessageView';
import { SettingsPage } from '@/features/settings/SettingsPage';

// ─────────────────────────── routing ───────────────────────────

export function App() {
  const theme = useUi((s) => s.theme);
  useEffect(() => {
    applyTheme(theme);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const h = () => applyTheme(theme);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, [theme]);

  return (
    <TooltipProvider>
      <Routes>
        <Route path="/login" element={<Gate mode="login" />} />
        <Route path="/setup" element={<Gate mode="setup" />} />
        <Route element={<Protected />}>
          <Route path="/settings/*" element={<Shell><SettingsPage /></Shell>} />
          <Route path="/a/:accountId" element={<InboxPage />} />
          <Route path="/a/:accountId/m/:messageId" element={<InboxPage />} />
          <Route path="/a/:accountId/f/:folderId" element={<InboxPage />} />
          <Route path="/a/:accountId/f/:folderId/m/:messageId" element={<InboxPage />} />
          <Route path="/m/:messageId" element={<InboxPage />} />
          <Route path="/" element={<InboxPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </TooltipProvider>
  );
}

function Gate({ mode }: { mode: 'login' | 'setup' }) {
  const { data, isLoading } = useAuthStatus();
  if (isLoading) return null;
  if (data?.authenticated) return <Navigate to="/" replace />;
  if (mode === 'login' && data?.needsSetup) return <Navigate to="/setup" replace />;
  if (mode === 'setup' && !data?.needsSetup) return <Navigate to="/login" replace />;
  return <AuthPage mode={mode} />;
}

function Protected() {
  const { data, isLoading } = useAuthStatus();
  const navigate = useNavigate();
  useEffect(() => {
    const h = () => navigate('/login', { replace: true });
    window.addEventListener('inbox:unauthorized', h);
    return () => window.removeEventListener('inbox:unauthorized', h);
  }, [navigate]);
  const authed = !!data?.authenticated;
  useEffect(() => {
    if (authed) void hydrateSettingsFromServer();
  }, [authed]);
  if (isLoading) return null;
  if (!authed) return <Navigate to={data?.needsSetup ? '/setup' : '/login'} replace />;
  return <Outlet />;
}

// ─────────────────────────── shell ───────────────────────────

function Shell({ children, list, view, showList = true, showView = true }: { children?: React.ReactNode; list?: React.ReactNode; view?: React.ReactNode; showList?: boolean; showView?: boolean }) {
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const setSidebarOpen = useUi((s) => s.setSidebarOpen);
  const listWidth = useUi((s) => s.listWidth);
  const setListWidth = useUi((s) => s.setListWidth);
  const dragging = useRef(false);

  const onDragStart = (e: React.MouseEvent) => {
    dragging.current = true;
    const startX = e.clientX;
    const startW = listWidth;
    const move = (ev: MouseEvent) => setListWidth(startW + ev.clientX - startX);
    const up = () => { dragging.current = false; window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); document.body.style.cursor = ''; };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    document.body.style.cursor = 'col-resize';
  };

  return (
    <div className="flex h-full bg-base">
      {/* desktop sidebar */}
      <aside className="hidden w-[232px] shrink-0 border-r border-subtle lg:block xl:w-[232px]">
        <Sidebar />
      </aside>
      {/* mobile drawer */}
      {sidebarOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40 animate-fade-in" onClick={() => setSidebarOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-[280px] shadow-lg animate-fade-in"><Sidebar onNavigate={() => setSidebarOpen(false)} /></aside>
        </div>
      ) : null}

      <main className="flex min-w-0 flex-1">
        {children ? (
          <div className="flex-1">{children}</div>
        ) : (
          <>
            <section className={cn('relative min-w-0 shrink-0 border-r border-subtle', showList ? 'flex' : 'hidden', 'w-full md:flex md:w-[var(--list-w)]')} style={{ ['--list-w' as string]: `${listWidth}px` }}>
              <div className="absolute left-2 top-3 z-10 lg:hidden">
                <IconButton label="菜单" onClick={() => setSidebarOpen(true)}><Menu className="h-4 w-4" /></IconButton>
              </div>
              <div className="min-w-0 flex-1 [&>div>div:first-child]:pl-12 lg:[&>div>div:first-child]:pl-3">{list}</div>
              <div onMouseDown={onDragStart} className="absolute -right-1 top-0 z-10 hidden h-full w-2 cursor-col-resize md:block" />
            </section>
            <section className={cn('min-w-0 flex-1', showView ? 'flex' : 'hidden', 'md:flex')}>
              <div className="min-w-0 flex-1">{view}</div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

// ─────────────────────────── inbox page ───────────────────────────

function InboxPage() {
  const { accountId, folderId, messageId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { data: accounts } = useAccounts();
  const scope = folderId ? `folder:${folderId}` : accountId ? `account:${accountId}` : 'unified';
  const selectedId = messageId ? Number(messageId) : null;
  const account = accounts?.find((a) => String(a.id) === accountId);
  const folder = folderId ? account?.folders.find((f) => String(f.id) === folderId) : undefined;
  const FOLDER_LABEL: Record<string, string> = { '\\Sent': '已发送', '\\Drafts': '草稿箱', '\\Junk': '垃圾邮件', '\\Trash': '已删除', '\\Archive': '归档' };
  const title = folder ? `${account?.name ?? ''} · ${(folder.specialUse && FOLDER_LABEL[folder.specialUse]) || folder.name}` : accountId ? (account?.name ?? '账户') : '统一收件箱';
  const base = folderId ? `/a/${accountId}/f/${folderId}` : accountId ? `/a/${accountId}` : '';

  const [searchParams, setSearchParams] = useSearchParams();
  const search = searchParams.get('q') ?? '';
  const onSearchChange = useCallback((q: string) => {
    setSearchParams((prev) => { const n = new URLSearchParams(prev); if (q) n.set('q', q); else n.delete('q'); return n; }, { replace: true });
  }, [setSearchParams]);

  // Automatic OAuth callback lands here with ?oauth=done|error
  useEffect(() => {
    const o = searchParams.get('oauth');
    if (!o) return;
    if (o === 'done') toast.success('账户已添加，开始同步');
    else toast.error('授权失败', { description: searchParams.get('message') ?? undefined });
    setSearchParams((prev) => { const n = new URLSearchParams(prev); n.delete('oauth'); n.delete('account'); n.delete('message'); return n; }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [pendingNew, setPendingNew] = useState(0);
  useServerEvents(
    useCallback((p: { accountId: number; folderId: number; specialUse: string | null; count: number }) => {
      // Only count mail landing in the folder currently shown (inbox views ignore other folders).
      const matches = folderId ? String(p.folderId) === folderId : p.specialUse === '\\Inbox' && (!accountId || String(p.accountId) === accountId);
      if (matches) setPendingNew((n) => n + p.count);
    }, [accountId, folderId]),
  );
  useEffect(() => setPendingNew(0), [scope]);

  const qs = search ? `?q=${encodeURIComponent(search)}` : '';
  const onSelect = useCallback((id: number) => navigate(`${base}/m/${id}${qs}`), [navigate, base, qs]);
  const onBack = useCallback(() => navigate((base || '/') + qs), [navigate, base, qs]);
  const onDeletedSelected = useCallback((nextId: number | null) => navigate((nextId ? `${base}/m/${nextId}` : base || '/') + qs, { replace: true }), [navigate, base, qs]);
  const batch = useBatchMessages();
  const listRef = useRef<{ deleteIds: (ids: number[]) => void } | null>(null);
  const onDeleteFromView = useCallback((id: number) => {
    if (listRef.current) listRef.current.deleteIds([id]);
    else { batch.mutate({ ids: [id], action: 'delete' }); onBack(); }
  }, [batch, onBack]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return;
      if (selectedId !== null) onBack();
      else if (search) onSearchChange('');
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [selectedId, onBack, search, onSearchChange]);

  const consume = useCallback(() => setPendingNew(0), []);
  const mobileShowView = selectedId !== null;

  return (
    <Shell
      key={location.pathname.startsWith('/settings') ? 'settings' : 'inbox'}
      showList={!mobileShowView}
      showView={mobileShowView}
      list={<MessageList ref={listRef} scope={scope} title={title} selectedId={selectedId} onSelect={onSelect} onDeletedSelected={onDeletedSelected} pendingNew={pendingNew} onConsumePending={consume} search={search} onSearchChange={onSearchChange} />}
      view={<MessageView id={selectedId} onBack={onBack} onDelete={onDeleteFromView} />}
    />
  );
}
