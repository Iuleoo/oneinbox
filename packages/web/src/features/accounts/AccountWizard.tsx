import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronLeft, Eye, EyeOff, ExternalLink, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { ACCOUNT_COLORS, type AccountColor, type ProviderId, type ProviderInfo } from '@inbox/shared';
import { api, HttpError } from '@/lib/api';
import { qk, useAccounts, useProviders } from '@/lib/queries';
import { cn, colorVar } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Dialog, DialogContent } from '@/components/ui/overlay';
import { OAuthPanel, pendingKey } from './OAuthPanel';

const LOGOS: Record<ProviderId, { mark: string; bg: string }> = {
  gmail: { mark: 'G', bg: '#ea4335' },
  qq: { mark: 'Q', bg: '#12b7f5' },
  outlook: { mark: 'O', bg: '#0078d4' },
  netease: { mark: '163', bg: '#d33' },
  custom: { mark: '@', bg: 'var(--fg-muted)' },
};

type Step = 'provider' | 'form';

export function AccountWizard({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { data: providers = [] } = useProviders();
  const [step, setStep] = useState<Step>('provider');
  const [provider, setProvider] = useState<ProviderInfo | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setStep('provider');
      setProvider(null);
      return;
    }
    // Resume an authorisation that was in progress when the dialog got closed.
    try {
      const pendingFor = providers.find(
        (p) => (p.id === 'gmail' && sessionStorage.getItem(pendingKey('google'))) || (p.id === 'outlook' && sessionStorage.getItem(pendingKey('microsoft'))),
      );
      if (pendingFor) {
        setProvider(pendingFor);
        setStep('form');
      }
    } catch { /* ignore */ }
  }, [open, providers]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={step === 'provider' ? '添加邮箱账户' : `添加 ${provider?.label}`} description={step === 'provider' ? '选择你的邮箱服务商' : undefined} lockOpen={busy}>
        {step === 'provider' ? (
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
            {providers.map((p) => (
              <button
                key={p.id}
                onClick={() => { setProvider(p); setStep('form'); }}
                className="flex flex-col items-start gap-3 rounded-[10px] border border-subtle bg-surface p-3.5 text-left transition-all hover:-translate-y-px hover:shadow-md"
              >
                <span className="flex h-8 w-8 items-center justify-center rounded-md text-[13px] font-bold text-white" style={{ background: LOGOS[p.id].bg }}>{LOGOS[p.id].mark}</span>
                <span className="text-[13.5px] font-medium">{p.label}</span>
              </button>
            ))}
          </div>
        ) : provider ? (
          <AccountForm provider={provider} onBack={() => setStep('provider')} onDone={() => onOpenChange(false)} onBusyChange={setBusy} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function AccountForm({ provider, onBack, onDone, onBusyChange }: { provider: ProviderInfo; onBack: () => void; onDone: () => void; onBusyChange?: (b: boolean) => void }) {
  const qc = useQueryClient();
  const { data: accounts = [] } = useAccounts();
  const oauthOnly = !provider.authTypes.includes('password');
  const [email, setEmail] = useState('');
  const [secret, setSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [name, setName] = useState('');
  const [host, setHost] = useState(provider.imapHost);
  const [port, setPort] = useState(String(provider.imapPort));
  const [tls, setTls] = useState(provider.imapTls);
  const [helpOpen, setHelpOpen] = useState(false);
  const [tested, setTested] = useState<null | { folders: number }>(null);
  const usedColors = accounts.map((a) => a.color);
  const [color, setColor] = useState<AccountColor>(ACCOUNT_COLORS.find((c) => !usedColors.includes(c)) ?? 'blue');

  const derivedName = useMemo(() => name || email.split('@')[0] || '', [name, email]);
  const payload = () => ({
    email: email.trim(),
    provider: provider.id,
    imapHost: provider.id === 'custom' ? host.trim() : undefined,
    imapPort: provider.id === 'custom' ? Number(port) || 993 : provider.imapPort,
    imapTls: provider.id === 'custom' ? tls : provider.imapTls,
    authType: 'password' as const,
    secret,
    allowInsecureTls: false,
  });

  const test = useMutation({
    mutationFn: () => api.accounts.test(payload()),
    onSuccess: (r) => setTested({ folders: r.folders }),
    onError: () => setTested(null),
  });
  const create = useMutation({
    mutationFn: () => api.accounts.create({ ...payload(), name: derivedName, color, syncDays: 30 }),
    onSuccess: (a) => {
      qc.invalidateQueries({ queryKey: qk.accounts });
      toast.success(`已添加 ${a.name}，开始同步`);
      onDone();
    },
  });

  useEffect(() => setTested(null), [email, secret, host, port, tls]);

  const err = (test.error ?? create.error) as HttpError | null;
  const canTest = !!email && !!secret && (provider.id !== 'custom' || !!host);

  const oauthKind = provider.id === 'gmail' ? 'google' : provider.id === 'outlook' ? 'microsoft' : null;
  const [mode, setMode] = useState<'oauth' | 'password'>(oauthOnly || provider.authTypes[0] === 'oauth2' ? 'oauth' : 'password');

  if (oauthKind && mode === 'oauth') {
    return (
      <div className="space-y-4">
        {!oauthOnly ? (
          <div className="inline-flex rounded-[var(--radius-sm)] bg-inset p-0.5 text-[12.5px] font-medium">
            <button type="button" className="h-7 rounded-[5px] bg-surface px-3 shadow-sm">授权登录（推荐）</button>
            <button type="button" className="h-7 rounded-[5px] px-3 text-muted hover:text-secondary" onClick={() => setMode('password')}>应用专用密码</button>
          </div>
        ) : null}
        <OAuthPanel provider={oauthKind} info={provider} onBack={onBack} onDone={onDone} onBusyChange={onBusyChange} ColorPicker={ColorPicker} />
      </div>
    );
  }

  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (tested) create.mutate(); else test.mutate(); }}>
      {oauthKind ? (
        <div className="inline-flex rounded-[var(--radius-sm)] bg-inset p-0.5 text-[12.5px] font-medium">
          <button type="button" className="h-7 rounded-[5px] px-3 text-muted hover:text-secondary" onClick={() => setMode('oauth')}>授权登录（推荐）</button>
          <button type="button" className="h-7 rounded-[5px] bg-surface px-3 shadow-sm">应用专用密码</button>
        </div>
      ) : null}
      <Field label="邮箱地址">
        <Input type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder={provider.id === 'qq' ? '123456@qq.com' : 'you@example.com'} required />
      </Field>
      <Field label={provider.id === 'gmail' ? '应用专用密码' : provider.id === 'custom' ? '密码' : '授权码'}>
        <div className="relative">
          <Input type={showSecret ? 'text' : 'password'} value={secret} onChange={(e) => setSecret(e.target.value)} className="pr-9" autoComplete="off" required />
          <button type="button" onClick={() => setShowSecret((v) => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-primary" aria-label="显示/隐藏">
            {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
      </Field>

      {provider.helpText ? (
        <div className="rounded-[8px] bg-inset">
          <button type="button" onClick={() => setHelpOpen((v) => !v)} className="flex w-full items-center justify-between px-3.5 py-2.5 text-[13px] font-medium text-secondary">
            如何获取{provider.id === 'gmail' ? '应用专用密码' : '授权码'}？
            <ChevronDown className={cn('h-4 w-4 transition-transform', helpOpen && 'rotate-180')} />
          </button>
          {helpOpen ? (
            <div className="px-3.5 pb-3 text-[13px] leading-relaxed text-muted">
              {provider.helpText}
              {provider.helpUrl ? (
                <a href={provider.helpUrl} target="_blank" rel="noreferrer" className="ml-1 inline-flex items-center gap-0.5 text-accent hover:underline">
                  官方说明 <ExternalLink className="h-3 w-3" />
                </a>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {provider.id === 'custom' ? (
        <div className="grid grid-cols-[1fr_88px_auto] gap-2.5">
          <Field label="IMAP 服务器"><Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="imap.example.com" required /></Field>
          <Field label="端口"><Input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" /></Field>
          <Field label="TLS">
            <select value={tls ? 'ssl' : 'starttls'} onChange={(e) => setTls(e.target.value === 'ssl')} className="h-9 rounded-[var(--radius-sm)] border border-subtle bg-surface px-2 text-sm">
              <option value="ssl">SSL/TLS</option>
              <option value="starttls">STARTTLS</option>
            </select>
          </Field>
        </div>
      ) : null}

      <div className="grid grid-cols-[1fr_auto] items-end gap-3">
        <Field label="显示名称"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={derivedName || '工作邮箱'} /></Field>
        <div>
          <span className="mb-1.5 block text-[12.5px] font-medium text-secondary">颜色</span>
          <ColorPicker value={color} onChange={setColor} />
        </div>
      </div>

      {err ? <div className="rounded-[8px] bg-danger-soft px-3.5 py-2.5 text-[13px] text-danger">{err.message}</div> : null}
      {tested && !err ? (
        <div className="flex items-center gap-2 rounded-[8px] bg-success-soft px-3.5 py-2.5 text-[13px] text-success">
          <Check className="h-4 w-4" /> 连接成功，找到 {tested.folders} 个文件夹
        </div>
      ) : null}

      <div className="flex items-center justify-between pt-1">
        <Button type="button" variant="ghost" onClick={onBack}><ChevronLeft className="h-4 w-4" /> 返回</Button>
        <div className="flex gap-2">
          {!tested ? (
            <Button type="submit" variant="primary" disabled={!canTest} loading={test.isPending}>{test.isPending ? '正在连接…' : '测试连接'}</Button>
          ) : (
            <Button type="submit" variant="primary" loading={create.isPending}>{create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null} 保存并开始同步</Button>
          )}
        </div>
      </div>
    </form>
  );
}

export function ColorPicker({ value, onChange }: { value: AccountColor; onChange: (c: AccountColor) => void }) {
  return (
    <div className="flex h-9 items-center gap-1.5">
      {ACCOUNT_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          aria-label={c}
          onClick={() => onChange(c)}
          className={cn('h-5 w-5 rounded-full transition-transform hover:scale-110', value === c && 'ring-2 ring-offset-2 ring-offset-elevated')}
          style={{ background: colorVar(c), ['--tw-ring-color' as string]: colorVar(c) }}
        />
      ))}
    </div>
  );
}
