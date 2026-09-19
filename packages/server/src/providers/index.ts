import type { AuthType, ProviderId, ProviderInfo } from '@inbox/shared';

export interface ProviderPreset {
  id: ProviderId;
  label: string;
  imapHost: string;
  imapPort: number;
  imapTls: boolean;
  authTypes: AuthType[];
  /** Whether the server requires the IMAP ID command before SELECT (NetEase). */
  requiresId: boolean;
  /** Prefer polling over IDLE because IDLE is unreliable on this provider. */
  preferPolling: boolean;
  /** Max time to stay in IDLE before probing for new mail (ms). Omit for the default (2 min). */
  idleProbeMs?: number;
  /** Max concurrent IMAP connections we allow ourselves per account. */
  maxConnections: number;
  helpText: string;
  helpUrl: string | null;
  /** Map raw IMAP error text to a user-friendly message. */
  friendlyAuthError: string;
  oauth?: {
    kind: 'google' | 'microsoft';
    authorizeUrl: string;
    tokenUrl: string;
    scope: string;
  };
}

const CLIENT_ID_INFO = {
  name: 'OneInbox',
  version: '1.0.0',
  vendor: 'inbox',
} as const;

export const CLIENT_INFO = CLIENT_ID_INFO;

export const PROVIDERS: Record<ProviderId, ProviderPreset> = {
  gmail: {
    id: 'gmail',
    label: 'Gmail',
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    imapTls: true,
    authTypes: ['oauth2', 'password'],
    requiresId: false,
    preferPolling: false,
    maxConnections: 1,
    helpText:
      '推荐使用 Google 授权（OAuth）。如使用应用专用密码，需先开启两步验证，再在 Google 账户 → 安全 → 应用专用密码 中生成。',
    helpUrl: 'https://myaccount.google.com/apppasswords',
    friendlyAuthError:
      'Gmail 登录失败。请确认已开启两步验证并使用 16 位应用专用密码（不是 Google 账户密码），或改用 Google 授权。',
    oauth: {
      kind: 'google',
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scope: 'https://mail.google.com/ openid email',
    },
  },
  qq: {
    id: 'qq',
    label: 'QQ 邮箱',
    imapHost: 'imap.qq.com',
    imapPort: 993,
    imapTls: true,
    authTypes: ['password'],
    requiresId: false,
    preferPolling: false,
    idleProbeMs: 90_000, // QQ accepts IDLE but does not push EXISTS in practice
    maxConnections: 1,
    helpText:
      '请使用 QQ 邮箱的「授权码」而非登录密码。获取方式：网页版 QQ 邮箱 → 设置 → 账户 → 开启 IMAP/SMTP 服务 → 生成授权码（需手机短信验证）。',
    helpUrl: 'https://service.mail.qq.com/detail/0/75',
    friendlyAuthError: 'QQ 邮箱授权码无效或已失效，请在网页版邮箱重新生成授权码（不是 QQ 密码）。',
  },
  outlook: {
    id: 'outlook',
    label: 'Outlook / Hotmail',
    imapHost: 'outlook.office365.com',
    imapPort: 993,
    imapTls: true,
    authTypes: ['oauth2'],
    requiresId: false,
    preferPolling: false,
    maxConnections: 1,
    helpText: 'Outlook 仅支持 Microsoft 授权登录，点击下方按钮跳转授权。',
    helpUrl: null,
    friendlyAuthError: 'Microsoft 授权已失效，请重新授权。',
    oauth: {
      kind: 'microsoft',
      authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      scope: 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access openid email',
    },
  },
  netease: {
    id: 'netease',
    label: '网易邮箱 (163 / 126)',
    imapHost: 'imap.163.com',
    imapPort: 993,
    imapTls: true,
    authTypes: ['password'],
    requiresId: true,
    preferPolling: true,
    maxConnections: 1,
    helpText:
      '请使用网易邮箱的「授权密码」。获取方式：网页版 → 设置 → POP3/SMTP/IMAP → 开启 IMAP/SMTP 服务 → 新增授权密码。126 邮箱请将服务器改为 imap.126.com。',
    helpUrl: 'https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac2',
    friendlyAuthError: '网易邮箱授权密码无效或已失效，请重新生成授权密码（不是邮箱登录密码）。',
  },
  custom: {
    id: 'custom',
    label: '其他 IMAP',
    imapHost: '',
    imapPort: 993,
    imapTls: true,
    authTypes: ['password'],
    requiresId: false,
    preferPolling: false,
    maxConnections: 1,
    helpText: '填写邮箱服务商提供的 IMAP 服务器地址、端口和登录凭据。',
    helpUrl: null,
    friendlyAuthError: 'IMAP 登录失败，请检查用户名和密码。',
  },
};

export function getProvider(id: ProviderId): ProviderPreset {
  return PROVIDERS[id];
}

/** Guess the host for NetEase sub-domains so users don't have to edit the host manually. */
export function inferImapHost(provider: ProviderId, email: string): string {
  const preset = PROVIDERS[provider];
  if (provider === 'netease') {
    const domain = email.split('@')[1]?.toLowerCase();
    if (domain === '126.com') return 'imap.126.com';
    if (domain === 'yeah.net') return 'imap.yeah.net';
  }
  if (provider === 'qq') return 'imap.qq.com';
  return preset.imapHost;
}

export function toProviderInfo(
  preset: ProviderPreset,
  oauthConfigured: boolean,
): ProviderInfo {
  return {
    id: preset.id,
    label: preset.label,
    imapHost: preset.imapHost,
    imapPort: preset.imapPort,
    imapTls: preset.imapTls,
    authTypes: preset.authTypes,
    helpText: preset.helpText,
    helpUrl: preset.helpUrl,
    oauthConfigured,
  };
}
