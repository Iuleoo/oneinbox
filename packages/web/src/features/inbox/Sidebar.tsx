import { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Archive, ChevronRight, FileText, Folder, Inbox, Loader2, LogOut, Moon, MoreHorizontal, Plus, RefreshCw, Send, Settings, ShieldAlert, Sun, SunMoon, Trash2, Pencil, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import type { Account, FolderInfo } from '@inbox/shared';
import { useParams } from 'react-router-dom';
import { api } from '@/lib/api';
import { qk, useAccounts } from '@/lib/queries';
import { useUi, type Theme } from '@/lib/store';
import { cn } from '@/lib/utils';
import { ColorDot } from '@/components/primitives';
import { IconButton } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, Tooltip } from '@/components/ui/overlay';
import { AccountWizard } from '@/features/accounts/AccountWizard';
import { EditAccountDialog } from '@/features/accounts/EditAccountDialog';

const THEME_CYCLE: Theme[] = ['system', 'light', 'dark'];
const THEME_ICON = { system: SunMoon, light: Sun, dark: Moon };
const THEME_LABEL = { system: '跟随系统', light: '浅色', dark: '深色' };

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { data: accounts = [] } = useAccounts();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const totalUnread = accounts.reduce((n, a) => n + (a.enabled ? a.unreadCount : 0), 0);
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  const ThemeIcon = THEME_ICON[theme];
  const navigate = useNavigate();
  const qc = useQueryClient();

  const logout = useMutation({
    mutationFn: api.auth.logout,
    onSuccess: () => {
      qc.clear();
      navigate('/login', { replace: true });
    },
  });

  return (
    <nav className="flex h-full flex-col bg-sidebar">
      <div className="flex items-center gap-2 px-4 pb-3 pt-4">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-accent text-accent-fg">
          <Inbox className="h-3.5 w-3.5" strokeWidth={2.25} />
        </div>
        <span className="text-[14px] font-semibold tracking-tight">OneInbox</span>
      </div>

      <div className="px-2">
        <NavItem to="/" end onClick={onNavigate} icon={<Inbox className="h-[18px] w-[18px]" strokeWidth={1.75} />} label="统一收件箱" count={totalUnread} />
      </div>

      <div className="mt-4 flex items-center justify-between px-4 pb-1">
        <span className="text-[11.5px] font-medium uppercase tracking-wider text-muted">账户</span>
        <Tooltip content="添加账户">
          <IconButton label="添加账户" className="h-6 w-6" onClick={() => setWizardOpen(true)}>
            <Plus className="h-3.5 w-3.5" />
          </IconButton>
        </Tooltip>
      </div>

      <div className="flex-1 overflow-y-auto px-2">
        {accounts.length === 0 ? (
          <button onClick={() => setWizardOpen(true)} className="mx-1 mt-1 w-[calc(100%-8px)] rounded-[var(--radius-md)] border border-dashed border-strong p-3 text-left text-[13px] text-muted hover:bg-hover hover:text-secondary">
            还没有邮箱账户，点击添加
          </button>
        ) : (
          accounts.map((a) => <AccountItem key={a.id} account={a} onNavigate={onNavigate} onEdit={() => setEditing(a)} />)
        )}
      </div>

      <div className="flex items-center gap-1 border-t border-subtle px-3 py-2.5">
        <Tooltip content={`主题：${THEME_LABEL[theme]}`}>
          <IconButton label="切换主题" onClick={() => setTheme(THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length]!)}>
            <ThemeIcon className="h-4 w-4" />
          </IconButton>
        </Tooltip>
        <Tooltip content="设置">
          <IconButton label="设置" onClick={() => { navigate('/settings'); onNavigate?.(); }}>
            <Settings className="h-4 w-4" />
          </IconButton>
        </Tooltip>
        <div className="flex-1" />
        <Tooltip content="退出登录">
          <IconButton label="退出登录" onClick={() => logout.mutate()}>
            <LogOut className="h-4 w-4" />
          </IconButton>
        </Tooltip>
      </div>

      <AccountWizard open={wizardOpen} onOpenChange={setWizardOpen} />
      {editing ? <EditAccountDialog account={editing} onClose={() => setEditing(null)} /> : null}
    </nav>
  );
}

function NavItem({ to, end, icon, label, count, onClick }: { to: string; end?: boolean; icon: React.ReactNode; label: string; count?: number; onClick?: () => void }) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onClick}
      className={({ isActive }) =>
        cn(
          'flex h-8 items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 text-[13.5px] font-medium transition-colors',
          isActive ? 'bg-active text-primary' : 'text-secondary hover:bg-hover hover:text-primary',
        )
      }
    >
      {({ isActive }) => (
        <>
          <span className={cn(isActive ? 'text-accent' : 'text-muted')}>{icon}</span>
          <span className="flex-1 truncate">{label}</span>
          {count ? <span className={cn('tnum text-[12px]', isActive ? 'text-accent' : 'text-secondary')}>{count}</span> : null}
        </>
      )}
    </NavLink>
  );
}

const FOLDER_ICON: Record<string, LucideIcon> = { '\\Inbox': Inbox, '\\Sent': Send, '\\Drafts': FileText, '\\Junk': ShieldAlert, '\\Trash': Trash2, '\\Archive': Archive };
const FOLDER_LABEL: Record<string, string> = { '\\Inbox': '收件箱', '\\Sent': '已发送', '\\Drafts': '草稿箱', '\\Junk': '垃圾邮件', '\\Trash': '已删除', '\\Archive': '归档' };

function FolderItem({ accountId, f, onNavigate }: { accountId: number; f: FolderInfo; onNavigate?: () => void }) {
  const Icon = (f.specialUse && FOLDER_ICON[f.specialUse]) || Folder;
  const label = (f.specialUse && FOLDER_LABEL[f.specialUse]) || f.name;
  const isInbox = f.specialUse === '\\Inbox';
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: () => api.accounts.patchFolder(accountId, f.id, { subscribed: !f.subscribed }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: qk.accounts });
      qc.invalidateQueries({ queryKey: ['messages'] });
      toast.success(r.subscribed ? `已开始同步「${label}」` : `已停止同步「${label}」`);
    },
    onError: (e) => toast.error('操作失败', { description: (e as Error).message }),
  });
  return (
    <NavLink
      onContextMenu={(e) => { if (isInbox) return; e.preventDefault(); if (confirm(f.subscribed ? `停止同步「${label}」？本地缓存的邮件会被清除，邮箱服务器不受影响。` : `开始同步「${label}」？`)) toggle.mutate(); }}
      to={isInbox ? `/a/${accountId}` : `/a/${accountId}/f/${f.id}`}
      end
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          'flex h-7 items-center gap-2 rounded-[var(--radius-sm)] pr-2.5 text-[13px] transition-colors',
          isActive ? 'bg-active text-primary' : 'text-secondary hover:bg-hover hover:text-primary',
          !f.subscribed && 'opacity-40',
        )
      }
      style={{ paddingLeft: 30 + f.depth * 12 }}
      title={f.subscribed ? `${f.path}（右键可停止同步）` : `${f.path}（未同步，右键可开启）`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted" strokeWidth={1.75} />
      <span className="flex-1 truncate">{label}</span>
      {f.unreadCount ? <span className="tnum text-[11.5px] text-muted">{f.unreadCount}</span> : null}
    </NavLink>
  );
}

function AccountItem({ account: a, onNavigate, onEdit }: { account: Account; onNavigate?: () => void; onEdit: () => void }) {
  const qc = useQueryClient();
  const params = useParams();
  const isThisAccount = params.accountId === String(a.id);
  // null = automatic (expanded while this account is being viewed); a boolean = user's explicit choice.
  const [manual, setManual] = useState<boolean | null>(null);
  useEffect(() => setManual(null), [isThisAccount]);
  const expanded = manual ?? isThisAccount;
  const folders = a.folders;
  const sync = useMutation({ mutationFn: () => api.accounts.sync(a.id), onSuccess: () => toast.success('已触发同步') });
  const toggle = useMutation({
    mutationFn: () => api.accounts.patch(a.id, { enabled: !a.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.accounts }),
  });
  const remove = useMutation({
    mutationFn: () => api.accounts.remove(a.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.accounts });
      qc.invalidateQueries({ queryKey: ['messages'] });
      toast.success(`已删除 ${a.name}`);
    },
    onError: (e) => toast.error('删除失败', { description: (e as Error).message }),
  });
  const syncing = a.status === 'syncing' || (a.syncProgress && a.syncProgress.done < a.syncProgress.total);
  const errored = a.status === 'error';

  return (
    <div>
      <div className="group relative">
      <NavLink
        to={`/a/${a.id}`}
        onClick={onNavigate}
        className={({ isActive }) =>
          cn(
            'flex h-8 items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 text-[13.5px] font-medium transition-colors',
            isActive ? 'bg-active text-primary' : 'text-secondary hover:bg-hover hover:text-primary',
            !a.enabled && 'opacity-50',
          )
        }
      >
        {({ isActive }) => (
          <>
            <span className="flex w-[18px] items-center justify-center" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setManual(!expanded); }}>
              {syncing ? (
                <Loader2 className="h-3 w-3 animate-spin text-muted" />
              ) : (
                <>
                  <ColorDot color={a.color} className="group-hover:hidden" />
                  <ChevronRight className={cn('hidden h-3.5 w-3.5 text-muted transition-transform group-hover:block', expanded && 'rotate-90')} />
                </>
              )}
            </span>
            <span className="flex-1 truncate">{a.name}</span>
            {errored ? (
              <Tooltip content={a.lastError ?? '同步出错'}>
                <AlertTriangle className="h-3.5 w-3.5 text-warning" />
              </Tooltip>
            ) : a.unreadCount ? (
              <span className={cn('tnum text-[12px] group-hover:hidden', isActive ? 'text-accent' : 'text-secondary')}>{a.unreadCount}</span>
            ) : null}
          </>
        )}
      </NavLink>
      {/* Stays mounted (opacity, not display) so the open menu keeps its anchor when the pointer leaves the row. */}
      <div className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100 has-[[data-state=open]]:opacity-100 focus-within:opacity-100">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton label="更多" className="h-6 w-6">
              <MoreHorizontal className="h-3.5 w-3.5" />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => sync.mutate()} disabled={!a.enabled}>
              <RefreshCw className="h-3.5 w-3.5" /> 立即同步
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onEdit}>
              <Pencil className="h-3.5 w-3.5" /> 编辑
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => toggle.mutate()}>{a.enabled ? '禁用' : '启用'}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem danger onSelect={() => { if (confirm(`删除账户「${a.name}」及其本地缓存的邮件？邮箱服务器上的邮件不受影响。`)) remove.mutate(); }}>
              <Trash2 className="h-3.5 w-3.5" /> 删除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      </div>
      {expanded && folders.length > 1 ? (
        <div className="mb-1 mt-0.5 space-y-px">
          {folders.map((f) => <FolderItem key={f.id} accountId={a.id} f={f} onNavigate={onNavigate} />)}
        </div>
      ) : null}
      {a.syncProgress && a.syncProgress.total > 0 && a.syncProgress.done < a.syncProgress.total ? (
        <div className="mx-2.5 -mt-0.5 h-0.5 overflow-hidden rounded bg-inset">
          <div className="h-full bg-accent transition-[width]" style={{ width: `${(a.syncProgress.done / a.syncProgress.total) * 100}%` }} />
        </div>
      ) : null}
    </div>
  );
}
