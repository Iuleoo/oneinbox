import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { Account, AccountColor } from '@inbox/shared';
import { api } from '@/lib/api';
import { qk } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Dialog, DialogContent } from '@/components/ui/overlay';
import { ColorPicker } from './AccountWizard';
import { OAuthPanel, pendingKey } from './OAuthPanel';
import { useProviders } from '@/lib/queries';

export function EditAccountDialog({ account, onClose }: { account: Account; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(account.name);
  const [color, setColor] = useState<AccountColor>(account.color);
  const [secret, setSecret] = useState('');
  const [syncDays, setSyncDays] = useState(String(account.syncDays));
  const [reauth, setReauth] = useState(() => {
    try { return !!sessionStorage.getItem(pendingKey(account.provider === 'gmail' ? 'google' : 'microsoft', account.id)); } catch { return false; }
  });
  const [busy, setBusy] = useState(false);
  const { data: providers } = useProviders();
  const oauthKind = account.authType === 'oauth2' ? (account.provider === 'gmail' ? 'google' : 'microsoft') : null;

  const save = useMutation({
    mutationFn: () =>
      api.accounts.patch(account.id, {
        name: name.trim() || account.name,
        color,
        syncDays: Math.max(1, Number(syncDays) || account.syncDays),
        ...(secret ? { secret } : {}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.accounts });
      toast.success('已保存');
      onClose();
    },
    onError: (e) => toast.error('保存失败', { description: (e as Error).message }),
  });

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent title={`编辑 ${account.name}`} description={account.email} lockOpen={busy}>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <div className="grid grid-cols-[1fr_auto] items-end gap-3">
            <Field label="显示名称"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <div>
              <span className="mb-1.5 block text-[12.5px] font-medium text-secondary">颜色</span>
              <ColorPicker value={color} onChange={setColor} />
            </div>
          </div>
          {account.authType === 'password' ? (
            <Field label="更换授权码 / 密码" hint="留空则保持不变。更换后会重新连接。">
              <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password" />
            </Field>
          ) : oauthKind && providers ? (
            reauth ? (
              <OAuthPanel provider={oauthKind} info={providers.find((p) => p.id === account.provider)!} accountId={account.id} onDone={onClose} onBusyChange={setBusy} />
            ) : (
              <div className="flex items-center justify-between rounded-[8px] bg-inset px-3.5 py-2.5 text-[13px]">
                <span className="text-secondary">通过 {oauthKind === 'google' ? 'Google' : 'Microsoft'} 授权登录</span>
                <Button type="button" size="sm" variant="secondary" onClick={() => setReauth(true)}>重新授权</Button>
              </div>
            )
          ) : null}
          <Field label="初始同步回溯天数" hint="仅影响下次完整同步">
            <Input value={syncDays} onChange={(e) => setSyncDays(e.target.value)} inputMode="numeric" className="w-32" />
          </Field>
          {account.lastError ? <div className="rounded-[8px] bg-danger-soft px-3.5 py-2.5 text-[13px] text-danger">上次错误：{account.lastError}</div> : null}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={onClose}>取消</Button>
            <Button type="submit" variant="primary" loading={save.isPending}>保存</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
