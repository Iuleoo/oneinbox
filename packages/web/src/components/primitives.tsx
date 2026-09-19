import type { AccountColor } from '@inbox/shared';
import { Inbox, Mail, type LucideIcon } from 'lucide-react';
import { cn, colorVar } from '@/lib/utils';

export function ColorDot({ color, size = 8, className }: { color: AccountColor; size?: number; className?: string }) {
  return <span aria-hidden className={cn('inline-block shrink-0 rounded-full', className)} style={{ width: size, height: size, background: colorVar(color) }} />;
}

export function EmptyState({ icon: Icon = Inbox, title, description }: { icon?: LucideIcon; title: string; description?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <Icon className="h-12 w-12 text-faint" strokeWidth={1.25} />
      <div>
        <p className="text-[14px] font-medium text-secondary">{title}</p>
        {description ? <p className="mt-1 text-[13px] text-muted">{description}</p> : null}
      </div>
    </div>
  );
}

export function NoSelection() {
  return <EmptyState icon={Mail} title="选择一封邮件开始阅读" />;
}

export function Avatar({ name, addr, color }: { name: string | null; addr: string | null; color: AccountColor }) {
  const text = (name || addr || '?').trim();
  const cjk = text.match(/[一-鿿]/);
  const init = cjk ? cjk[0] : text.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');
  return (
    <div
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold text-white"
      style={{ background: colorVar(color) }}
      aria-hidden
    >
      {init || '?'}
    </div>
  );
}
