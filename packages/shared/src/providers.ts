import { z } from 'zod';

export const PROVIDER_IDS = ['gmail', 'qq', 'outlook', 'netease', 'custom'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
export const providerIdSchema = z.enum(PROVIDER_IDS);

export const AUTH_TYPES = ['password', 'oauth2'] as const;
export type AuthType = (typeof AUTH_TYPES)[number];
export const authTypeSchema = z.enum(AUTH_TYPES);

export const ACCOUNT_COLORS = [
  'blue',
  'violet',
  'pink',
  'orange',
  'amber',
  'green',
  'teal',
  'slate',
] as const;
export type AccountColor = (typeof ACCOUNT_COLORS)[number];
export const accountColorSchema = z.enum(ACCOUNT_COLORS);

export const ACCOUNT_STATUSES = ['idle', 'syncing', 'connected', 'error', 'disabled'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/** Public provider preset returned by GET /api/providers. */
export interface ProviderInfo {
  id: ProviderId;
  label: string;
  imapHost: string;
  imapPort: number;
  imapTls: boolean;
  authTypes: AuthType[];
  helpText: string;
  helpUrl: string | null;
  /** Whether OAuth client credentials are configured server-side (only meaningful for oauth2 providers). */
  oauthConfigured: boolean;
}
