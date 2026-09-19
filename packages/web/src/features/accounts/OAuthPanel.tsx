import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronLeft, ExternalLink, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type { AccountColor, OAuthProvider, ProviderInfo } from '@inbox/shared';
import { api, HttpError } from '@/lib/api';
import { qk, useAccounts } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';

const PROVIDER_LABEL: Record<OAuthProvider, string> = { google: 'Google', microsoft: 'Microsoft' };
const CONSOLE_URL: Record<OAuthProvider, string> = {
  google: 'https://console.cloud.google.com/apis/credentials',
  microsoft: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
};

export interface OAuthPanelProps {
  provider: OAuthProvider;
  info: ProviderInfo;
  /** New account: name + colour. Re-auth: accountId. */
  name?: string;
  color?: AccountColor;
  accountId?: number;
  onBack?: () => void;
  onDone: () => void;
  /** Reports whether an authorisation is in flight so the host dialog can refuse to close. */
  onBusyChange?: (busy: boolean) => void;
  ColorPicker?: React.ComponentType<{ value: AccountColor; onChange: (c: AccountColor) => void }>;
}

type Started = { state: string; redirectUri: string; url: string; at: number };
const PENDING_TTL = 15 * 60_000;
export const pendingKey = (provider: OAuthProvider, accountId?: number) => `oauth-pending:${provider}:${accountId ?? 'new'}`;
function loadPending(provider: OAuthProvider, accountId?: number): Started | null {
  try {
    const raw = sessionStorage.getItem(pendingKey(provider, accountId));
    if (!raw) return null;
    const v = JSON.parse(raw) as Started;
    if (Date.now() - v.at > PENDING_TTL) {
      sessionStorage.removeItem(pendingKey(provider, accountId));
      return null;
    }
    return v;
  } catch {
    return null;
  }
}

/**
 * OAuth authorisation flow with two completion paths:
 *  1. automatic — the provider redirects to /oauth/<p>/callback on this host; we poll status.
 *  2. manual — the registered redirect URI is elsewhere (e.g. localhost); the user pastes the
 *     URL they landed on and we finish the exchange server-side.
 */
export function OAuthPanel({ provider, info, name: initialName, color: initialColor, accountId, onBack, onDone, onBusyChange, ColorPicker }: OAuthPanelProps) {
  const qc = useQueryClient();
  const { data: accounts = [] } = useAccounts();
  const cfg = useQuery({ queryKey: ['oauth-config', provider], queryFn: () => api.oauth.config(provider) });
  const [editCfg, setEditCfg] = useState(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [redirectUri, setRedirectUri] = useState('');
  const [name, setName] = useState(initialName ?? '');
  const [color, setColor] = useState<AccountColor>(initialColor ?? 'blue');
  // Survives the dialog being closed (e.g. by an outside click after coming back from the auth tab).
  const [started, setStartedRaw] = useState<Started | null>(() => loadPending(provider, accountId));
  const setStarted = (v: Started | null) => {
    setStartedRaw(v);
    try {
      if (v) sessionStorage.setItem(pendingKey(provider, accountId), JSON.stringify(v));
      else sessionStorage.removeItem(pendingKey(provider, accountId));
    } catch { /* ignore */ }
  };
  useEffect(() => {
    onBusyChange?.(!!started);
    return () => onBusyChange?.(false);
  }, [started, onBusyChange]);
  const [pasted, setPasted] = useState('');
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    if (cfg.data && !editCfg) {
      setClientId(cfg.data.clientId ?? '');
      setRedirectUri(cfg.data.redirectUri);
      if (!cfg.data.configured) setEditCfg(true);
    }
  }, [cfg.data, editCfg]);

  const saveCfg = useMutation({
    mutationFn: () => api.oauth.saveConfig(provider, { clientId: clientId.trim(), clientSecret: clientSecret || undefined, redirectUri: redirectUri.trim() || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['oauth-config', provider] });
      qc.invalidateQueries({ queryKey: qk.providers });
      setClientSecret('');
      setEditCfg(false);
      toast.success('OAuth 客户端已保存');
    },
  });

  const start = useMutation({
    mutationFn: () => api.oauth.start(provider, { name: name.trim() || undefined, color, accountId }),
    onSuccess: (r) => {
      setStarted({ ...r, at: Date.now() });
      window.open(r.url, '_blank', 'noopener');
    },
  });

  const complete = useMutation({
    mutationFn: (url: string) => api.oauth.complete(provider, { url }),
    onSuccess: finish,
  });

  function finish() {
    if (pollRef.current) window.clearInterval(pollRef.current);
    setStarted(null);
    qc.invalidateQueries({ queryKey: qk.accounts });
    qc.invalidateQueries({ queryKey: ['messages'] });
    toast.success(accountId ? '已重新授权' : '账户已添加，开始同步');
    onDone();
  }

  // Poll for automatic completion (callback served by this host).
  useEffect(() => {
    if (!started) return;
    pollRef.current = window.setInterval(async () => {
      try {
        const s = await api.oauth.status(started.state);
        if (s.status === 'done') finish();
        else if (s.status === 'error') {
          window.clearInterval(pollRef.current!);
          toast.error('授权失败', { description: s.message });
          setStarted(null);
        }
      } catch {
        /* ignore transient */
      }
    }, 2000);
    return () => { if (pollRef.current) window.clearInterval(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started]);

  const sameHost = (() => {
    try { return started ? new URL(started.redirectUri).host === location.host : false; } catch { return false; }
  })();
  const err = (saveCfg.error ?? start.error ?? complete.error) as HttpError | null;
  const label = PROVIDER_LABEL[provider];

  // Inspect the pasted redirect URL client-side so provider errors are visible immediately.
  const pastedInfo = (() => {
    const v = pasted.trim();
    if (!v) return { ok: false, hint: '' };
    let u: URL;
    try { u = new URL(v); } catch { return { ok: false, hint: '不是完整的 URL，请从浏览器地址栏整段复制' }; }
    const e = u.searchParams.get('error');
    if (e) return { ok: false, hint: `${label} 返回错误：${e}${u.searchParams.get('error_description') ? ' · ' + decodeURIComponent(u.searchParams.get('error_description')!) : ''}。请点"重新打开"再授权一次` };
    if (!u.searchParams.get('code') || !u.searchParams.get('state')) return { ok: false, hint: 'URL 里没有 code 和 state 参数' };
    if (started && u.searchParams.get('state') !== started.state) return { ok: false, hint: '这个 URL 属于另一次授权（state 不匹配），请点"重新打开"后使用最新的跳转地址' };
    return { ok: true, hint: '' };
  })();

  return (
    <div className="space-y-4">
      {/* client configuration */}
      <div className="rounded-[10px] border border-subtle bg-base">
        <button type="button" onClick={() => setEditCfg((v) => !v)} className="flex w-full items-center justify-between px-3.5 py-2.5 text-left text-[13px]">
          <span className="font-medium">
            {cfg.data?.configured ? (
              <span className="inline-flex items-center gap-1.5 text-success"><Check className="h-3.5 w-3.5" /> {label} 应用已配置<span className="font-normal text-muted">（一个应用可授权多个账户，无需重复注册）</span></span>
            ) : (
              `配置 ${label} 应用`
            )}
          </span>
          <ChevronDown className={cn('h-4 w-4 text-muted transition-transform', editCfg && 'rotate-180')} />
        </button>
        {editCfg ? (
          <div className="space-y-3 border-t border-subtle px-3.5 py-3">
            <p className="text-[12.5px] leading-relaxed text-muted">
              在 <a href={CONSOLE_URL[provider]} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-accent hover:underline">{label} 控制台 <ExternalLink className="h-3 w-3" /></a> 注册应用，把回调地址填成下方的值（{provider === 'microsoft' ? 'Microsoft 只接受 https 或 localhost' : 'Google 接受 http://localhost 或 https'}）。
            </p>
            <Field label="Client ID"><Input value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" /></Field>
            <Field label="Client Secret" hint={cfg.data?.configured ? '留空保持不变' : undefined}><Input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="new-password" /></Field>
            <Field label="回调地址（需与控制台一致）" hint={`默认：${cfg.data?.defaultRedirectUri ?? ''}`}>
              <Input value={redirectUri} onChange={(e) => setRedirectUri(e.target.value)} placeholder={cfg.data?.defaultRedirectUri} className="font-mono text-[12.5px]" />
            </Field>
            <div className="flex justify-end">
              <Button size="sm" variant="primary" loading={saveCfg.isPending} disabled={!clientId.trim() || (!cfg.data?.configured && !clientSecret)} onClick={() => saveCfg.mutate()}>保存</Button>
            </div>
          </div>
        ) : null}
      </div>

      {!accountId ? (
        <div className="grid grid-cols-[1fr_auto] items-end gap-3">
          <Field label="显示名称"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={`我的 ${label === 'Google' ? 'Gmail' : 'Outlook'}`} /></Field>
          {ColorPicker ? (
            <div>
              <span className="mb-1.5 block text-[12.5px] font-medium text-secondary">颜色</span>
              <ColorPicker value={color} onChange={setColor} />
            </div>
          ) : null}
        </div>
      ) : null}

      {/* authorise */}
      {!started ? (
        <Button variant="primary" size="lg" className="w-full" disabled={!cfg.data?.configured} loading={start.isPending} onClick={() => start.mutate()}>
          使用 {label} 授权{accountId ? '（重新授权）' : ''}
        </Button>
      ) : (
        <div className="space-y-3 rounded-[10px] bg-inset p-3.5 text-[13px]">
          <div className="flex items-center gap-2 text-secondary">
            <Loader2 className="h-4 w-4 animate-spin" /> 已在新标签页打开 {label} 授权页面，等待完成…
            <a href={started.url} target="_blank" rel="noreferrer" className="ml-auto text-accent hover:underline">重新打开</a>
            <button type="button" className="text-muted hover:text-primary" onClick={() => setStarted(null)}>取消</button>
          </div>
          {!sameHost ? (
            <>
              <p className="text-muted">
                回调地址是 <code className="rounded bg-surface px-1 font-mono text-[12px]">{started.redirectUri}</code>，授权后浏览器会跳到那里。如果页面打不开，把地址栏里的完整 URL 粘贴到下面：
              </p>
              <div className="flex gap-2">
                <Input value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="http://localhost:8080/oauth/…?code=…&state=…" className="font-mono text-[12px]" />
                <Button variant="primary" loading={complete.isPending} disabled={!pastedInfo.ok} onClick={() => complete.mutate(pasted)}>完成</Button>
              </div>
              {pastedInfo.hint ? <p className={cn('text-[12.5px]', pastedInfo.ok ? 'text-muted' : 'text-danger')}>{pastedInfo.hint}</p> : null}
            </>
          ) : null}
        </div>
      )}

      {err ? <div className="rounded-[8px] bg-danger-soft px-3.5 py-2.5 text-[13px] text-danger">{err.message}</div> : null}
      <p className="text-[12.5px] text-muted">{info.helpText}</p>

      {onBack ? (
        <div className="flex justify-between pt-1">
          <Button type="button" variant="ghost" onClick={onBack}><ChevronLeft className="h-4 w-4" /> 返回</Button>
        </div>
      ) : null}
      <span className="hidden">{accounts.length}</span>
    </div>
  );
}
