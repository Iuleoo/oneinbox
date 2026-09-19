import { useEffect, useState } from 'react';
import { Dialog, DialogContent } from '@/components/ui/overlay';
import { Kbd } from '@/components/ui/input';

const GROUPS: { title: string; keys: [string, string][] }[] = [
  { title: '导航', keys: [['j / ↓', '下一封'], ['k / ↑', '上一封'], ['Enter', '打开选中邮件'], ['Esc', '关闭邮件 / 清除搜索 / 取消多选']] },
  { title: '操作', keys: [['u', '切换已读 / 未读'], ['s', '切换星标'], ['# / Delete', '删除（移到废纸篓）'], ['x', '选中 / 取消选中当前邮件']] },
  { title: '其他', keys: [['/ 或 Ctrl+K', '聚焦搜索'], ['?', '显示此面板']] },
];

/** Global "?" shortcut panel. Mounted once in the app shell. */
export function ShortcutsDialog() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
      if (e.key === '?' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent title="键盘快捷键" description="在列表或阅读窗格中可用；输入框内不生效">
        <div className="grid gap-5 sm:grid-cols-2">
          {GROUPS.map((g) => (
            <div key={g.title}>
              <h3 className="mb-2 text-[12px] font-medium uppercase tracking-wider text-muted">{g.title}</h3>
              <div className="space-y-1.5">
                {g.keys.map(([k, l]) => (
                  <div key={k} className="flex items-center justify-between gap-3 text-[13px]">
                    <span className="text-secondary">{l}</span>
                    <span className="flex shrink-0 gap-1">{k.split(' / ').map((x) => <Kbd key={x}>{x}</Kbd>)}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
