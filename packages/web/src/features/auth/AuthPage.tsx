import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Inbox } from 'lucide-react';
import { api, HttpError } from '@/lib/api';
import { qk } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';

export function AuthPage({ mode }: { mode: 'login' | 'setup' }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const navigate = useNavigate();
  const qc = useQueryClient();

  const m = useMutation({
    mutationFn: () => (mode === 'login' ? api.auth.login({ username, password }) : api.auth.setup({ username, password })),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.auth });
      navigate('/', { replace: true });
    },
  });
  const err = m.error as HttpError | null;
  const mismatch = mode === 'setup' && confirm.length > 0 && confirm !== password;

  return (
    <div className="flex min-h-full items-center justify-center bg-base p-6">
      <div className="w-full max-w-[360px] rounded-[var(--radius-lg)] border border-subtle bg-surface p-7 shadow-md animate-fade-in">
        <div className="mb-6 flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-accent text-accent-fg">
            <Inbox className="h-4 w-4" strokeWidth={2.25} />
          </div>
          <div>
            <h1 className="text-[15px] font-semibold leading-5">OneInbox</h1>
            <p className="text-[12.5px] text-muted">{mode === 'login' ? '登录以查看你的邮件' : '首次使用，创建管理员账号'}</p>
          </div>
        </div>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (!mismatch) m.mutate(); }}>
          <Field label="用户名"><Input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required /></Field>
          <Field label="密码"><Input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
          {mode === 'setup' ? (
            <Field label="确认密码"><Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required /></Field>
          ) : null}
          {err || mismatch ? <div className="rounded-[8px] bg-danger-soft px-3.5 py-2.5 text-[13px] text-danger">{mismatch ? '两次输入的密码不一致' : err?.message}</div> : null}
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={m.isPending}>{mode === 'login' ? '登录' : '创建并登录'}</Button>
        </form>
      </div>
    </div>
  );
}
