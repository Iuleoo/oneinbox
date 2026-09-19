import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { ACCOUNT_COLORS, type AccountColor } from '@inbox/shared';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const DAY = 86_400_000;

/** List-style relative date: 今天 HH:mm · 昨天 · 周三 · 9月15日 · 2025/12/3 */
export function formatListDate(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const n = new Date(now);
  const startToday = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  if (ts >= startToday) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (ts >= startToday - DAY) return '昨天';
  if (ts >= startToday - 6 * DAY) return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]!;
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export function formatFullDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function pad(n: number) {
  return n < 10 ? `0${n}` : String(n);
}

export function formatSize(bytes: number | null | undefined): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function initials(name: string | null, addr: string | null): string {
  const src = (name || addr || '?').trim();
  const cjk = src.match(/[一-鿿]/);
  if (cjk) return cjk[0];
  const parts = src.split(/[\s@._-]+/).filter(Boolean);
  const a = parts[0]?.[0] ?? '?';
  const b = parts.length > 1 ? parts[1]![0] : '';
  return (a + (b ?? '')).toUpperCase();
}

/** Stable colour for a sender, drawn from the account palette. */
export function senderColor(addr: string | null): AccountColor {
  let h = 0;
  for (const ch of addr ?? '') h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return ACCOUNT_COLORS[h % ACCOUNT_COLORS.length]!;
}

export const colorVar = (c: AccountColor) => `var(--c-${c})`;

export function displayName(name: string | null, addr: string | null): string {
  return name?.trim() || addr || '(未知发件人)';
}
