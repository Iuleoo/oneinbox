import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Settings } from '@inbox/shared';
import { api } from './api';

export type Theme = 'light' | 'dark' | 'system';

interface UiState {
  theme: Theme;
  setTheme: (t: Theme) => void;
  listWidth: number;
  setListWidth: (w: number) => void;
  sidebarOpen: boolean; // mobile drawer
  setSidebarOpen: (v: boolean) => void;
  autoMarkReadMs: number;
  showRemoteImages: 'never' | 'ask' | 'always';
  setShowRemoteImages: (v: 'never' | 'ask' | 'always') => void;
  /** Senders the user chose "always show images" for. */
  trustedSenders: string[];
  trustSender: (addr: string) => void;
  bodyCacheMaxMb: number;
  /** True once server settings have been loaded into the store (enables write-back). */
  hydrated: boolean;
}

const SYNCED_KEYS = ['theme', 'autoMarkReadMs', 'showRemoteImages', 'trustedSenders', 'bodyCacheMaxMb'] as const;

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      theme: 'system',
      setTheme: (theme) => set({ theme }),
      listWidth: 380,
      setListWidth: (listWidth) => set({ listWidth: Math.min(520, Math.max(320, listWidth)) }),
      sidebarOpen: false,
      setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
      autoMarkReadMs: 1500,
      showRemoteImages: 'ask',
      setShowRemoteImages: (showRemoteImages) => set({ showRemoteImages }),
      trustedSenders: [],
      trustSender: (addr) => set((s) => ({ trustedSenders: [...new Set([...s.trustedSenders, addr.toLowerCase()])] })),
      bodyCacheMaxMb: 500,
      hydrated: false,
    }),
    { name: 'inbox-ui', partialize: (s) => ({ theme: s.theme, listWidth: s.listWidth, autoMarkReadMs: s.autoMarkReadMs, showRemoteImages: s.showRemoteImages, trustedSenders: s.trustedSenders, bodyCacheMaxMb: s.bodyCacheMaxMb }) },
  ),
);

export function applyTheme(theme: Theme) {
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

export function isDark(): boolean {
  return document.documentElement.dataset.theme === 'dark';
}

/**
 * Load server-side settings into the store once, then write back any change to the synced
 * keys (debounced). localStorage keeps a copy so the UI paints correctly before the fetch.
 */
export async function hydrateSettingsFromServer(): Promise<void> {
  try {
    const s = await api.settings.get();
    useUi.setState({ ...pickSynced(s), hydrated: true });
  } catch {
    useUi.setState({ hydrated: true }); // offline: keep local values, still allow later writes
  }
}

function pickSynced(s: Partial<Settings>): Partial<Settings> {
  const out: Partial<Settings> = {};
  for (const k of SYNCED_KEYS) if (s[k] !== undefined) (out as Record<string, unknown>)[k] = s[k];
  return out;
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;
let pending: Partial<Settings> = {};
useUi.subscribe((state, prev) => {
  // Skip until hydrated, and skip the hydration tick itself (would echo server values back).
  if (!state.hydrated || !prev.hydrated) return;
  const diff: Partial<Settings> = {};
  for (const k of SYNCED_KEYS) if (state[k] !== prev[k]) (diff as Record<string, unknown>)[k] = state[k];
  if (!Object.keys(diff).length) return;
  pending = { ...pending, ...diff };
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    const p = pending;
    pending = {};
    api.settings.patch(p).catch(() => undefined);
  }, 500);
});
