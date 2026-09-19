import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { api, HttpError } from '@/lib/api';
import { ArrowLeft } from 'lucide-react';
import { useUi, type Theme } from '@/lib/store';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Field, Input, Kbd } from '@/components/ui/input';

export function SettingsPage() {
  const navigate = useNavigate();
  const ui = useUi();
  return (
    <div className="h-full overflow-y-auto bg-surface">
      <div className="mx-auto max-w-[640px] px-6 py-6">
        <div className="mb-6 flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => navigate('/')}><ArrowLeft className="h-4 w-4" /> 返回</Button>
          <h1 className="text-[18px] font-semibold tracking-tight">设置</h1>
        </div>

        <Section title="外观">
          <Row label="主题">
            <Segmented value={ui.theme} onChange={(v) => ui.setTheme(v as Theme)} options={[['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']]} />
          </Row>
        </Section>

        <Section title="阅读">
          <Row label="自动标记已读" hint="打开邮件后多久标为已读">
            <Segmented
              value={String(ui.autoMarkReadMs)}
              onChange={(v) => useUi.setState({ autoMarkReadMs: Number(v) })}
              options={[['0', '立即'], ['1500', '1.5 秒'], ['5000', '5 秒'], ['-1', '手动']]}
            />
          </Row>
          <Row label="远程图片" hint="邮件中的外链图片可能被用来追踪你">
            <Segmented value={ui.showRemoteImages} onChange={(v) => ui.setShowRemoteImages(v as 'never' | 'ask' | 'always')} options={[['ask', '询问'], ['always', '总是显示'], ['never', '从不']]} />
          </Row>
        </Section>

        <Section title="存储">
          <Row label="正文缓存上限" hint="超过后自动清理最久未读的正文，需要时会重新拉取">
            <Segmented value={String(ui.bodyCacheMaxMb)} onChange={(v) => useUi.setState({ bodyCacheMaxMb: Number(v) })} options={[['200', '200 MB'], ['500', '500 MB'], ['2000', '2 GB']]} />
          </Row>
        </Section>

        <Section title="账户安全">
          <ChangePassword />
        </Section>

        <Section title="快捷键">
          <div className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-[13px]">
            {([['j / ↓', '下一封'], ['k / ↑', '上一封'], ['u', '切换已读 / 未读'], ['s', '切换星标'], ['#', '删除（移到废纸篓）'], ['x', '选中 / 取消选中当前邮件'], ['/ 或 Ctrl+K', '聚焦搜索'], ['Esc', '关闭邮件 / 清除搜索']] as const).map(([k, l]) => (
              <>
                <span key={k} className="flex gap-1">{k.split(' / ').map((x) => <Kbd key={x}>{x}</Kbd>)}</span>
                <span key={k + l} className="text-secondary">{l}</span>
              </>
            ))}
          </div>
        </Section>

        <Section title="关于">
          <p className="text-[13px] text-muted">OneInbox · 轻量级多邮箱聚合客户端 · v0.6</p>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-[12px] font-medium uppercase tracking-wider text-muted">{title}</h2>
      <div className="space-y-4 rounded-[10px] border border-subtle bg-base p-4">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="text-[13.5px] font-medium">{label}</p>
        {hint ? <p className="text-[12.5px] text-muted">{hint}</p> : null}
      </div>
      {children}
    </div>
  );
}

function Segmented({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: readonly (readonly [string, string])[] }) {
  return (
    <div className="inline-flex rounded-[var(--radius-sm)] bg-inset p-0.5">
      {options.map(([v, l]) => (
        <button key={v} onClick={() => onChange(v)} className={cn('h-7 rounded-[5px] px-2.5 text-[12.5px] font-medium transition-colors', value === v ? 'bg-surface text-primary shadow-sm' : 'text-muted hover:text-secondary')}>
          {l}
        </button>
      ))}
    </div>
  );
}

function ChangePassword() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const m = useMutation({
    mutationFn: () => api.auth.changePassword({ currentPassword: current, newPassword: next }),
    onSuccess: () => {
      toast.success('密码已更新，其他设备已退出登录');
      setCurrent(''); setNext(''); setConfirm('');
    },
  });
  const err = m.error as HttpError | null;
  const mismatch = confirm.length > 0 && confirm !== next;
  const tooShort = next.length > 0 && next.length < 8;
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (!mismatch && !tooShort) m.mutate(); }}>
      <p className="text-[13.5px] font-medium">修改登录密码</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="当前密码"><Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required /></Field>
        <Field label="新密码"><Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={8} /></Field>
        <Field label="确认新密码"><Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required /></Field>
      </div>
      {err || mismatch || tooShort ? (
        <div className="rounded-[8px] bg-danger-soft px-3.5 py-2.5 text-[13px] text-danger">{mismatch ? '两次输入的新密码不一致' : tooShort ? '新密码至少 8 位' : err?.message}</div>
      ) : null}
      <div className="flex justify-end">
        <Button type="submit" variant="primary" size="sm" loading={m.isPending} disabled={!current || !next || !confirm}>更新密码</Button>
      </div>
    </form>
  );
}
