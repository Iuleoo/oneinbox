import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Download, Eye, FileText, Image as ImageIcon, Mail, MailOpen, Paperclip, ShieldAlert, Star, Trash2 } from 'lucide-react';
import type { AttachmentInfo, MessageDetail } from '@inbox/shared';
import { api } from '@/lib/api';
import { useAccounts, useMessage, useMessageBody, usePatchMessage } from '@/lib/queries';
import { useUi } from '@/lib/store';
import { cn, formatFullDate, formatSize, senderColor, displayName } from '@/lib/utils';
import { Avatar, ColorDot, EmptyState, NoSelection } from '@/components/primitives';
import { Button, IconButton } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/input';
import { Tooltip } from '@/components/ui/overlay';
import { BodyFrame } from './BodyFrame';

export function MessageView({ id, onBack, onDelete }: { id: number | null; onBack?: () => void; onDelete?: (id: number) => void }) {
  const detail = useMessage(id);
  const body = useMessageBody(id);
  const patch = usePatchMessage();
  const { data: accounts } = useAccounts();
  const autoMs = useUi((s) => s.autoMarkReadMs);
  const remotePref = useUi((s) => s.showRemoteImages);
  const trusted = useUi((s) => s.trustedSenders);
  const trustSender = useUi((s) => s.trustSender);
  const [showImages, setShowImages] = useState(false);
  const [showAllRecipients, setShowAllRecipients] = useState(false);
  const account = accounts?.find((a) => a.id === detail.data?.accountId);

  // Reset per-message UI state
  useEffect(() => {
    setShowAllRecipients(false);
    const from = detail.data?.fromAddr?.toLowerCase();
    setShowImages(remotePref === 'always' || (!!from && trusted.includes(from)));
  }, [id, detail.data?.fromAddr, remotePref, trusted]);

  // Auto mark-read after a short dwell
  const seenRef = useRef<number | null>(null);
  useEffect(() => {
    const m = detail.data;
    if (!m || m.seen || autoMs < 0 || seenRef.current === m.id) return;
    const t = setTimeout(() => {
      seenRef.current = m.id;
      patch.mutate({ id: m.id, patch: { seen: true } });
    }, autoMs);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.data?.id, detail.data?.seen, autoMs]);

  if (id === null) return <div className="h-full bg-surface"><NoSelection /></div>;
  if (detail.isError) return <div className="h-full bg-surface"><EmptyState title="邮件不存在" description={(detail.error as Error).message} /></div>;
  const m = detail.data;

  return (
    <div className="flex h-full flex-col bg-surface">
      <Toolbar m={m} onBack={onBack} onPatch={(p) => m && patch.mutate({ id: m.id, patch: p })} onDelete={() => m && onDelete?.(m.id)} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <article className="mx-auto max-w-[840px] px-6 py-6 md:px-10 md:py-8">
          {!m ? (
            <HeaderSkeleton />
          ) : (
            <>
              <div className="flex items-start justify-between gap-4">
                <h1 className="text-[20px] font-semibold leading-7 tracking-tight [overflow-wrap:anywhere]">{m.subject || '(无主题)'}</h1>
                {account ? (
                  <span className="mt-0.5 inline-flex shrink-0 items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1 text-[12px] font-medium text-accent">
                    <ColorDot color={account.color} size={6} /> {account.name}
                  </span>
                ) : null}
              </div>

              <div className="mt-5 flex items-start gap-3">
                <Avatar name={m.fromName} addr={m.fromAddr} color={senderColor(m.fromAddr)} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="min-w-0 truncate text-[14px]">
                      <span className="font-semibold">{displayName(m.fromName, m.fromAddr)}</span>
                      {m.fromName && m.fromAddr ? <span className="text-muted"> &lt;{m.fromAddr}&gt;</span> : null}
                    </div>
                    <span className="tnum shrink-0 text-[12.5px] text-muted">{formatFullDate(m.internalDate)}</span>
                  </div>
                  <button onClick={() => setShowAllRecipients((v) => !v)} className="mt-0.5 max-w-full truncate text-left text-[13px] text-muted hover:text-secondary">
                    {showAllRecipients ? (
                      <span className="whitespace-normal">
                        发送至 {m.to.map((t) => t.name ? `${t.name} <${t.address}>` : t.address).join(', ') || '—'}
                        {m.cc.length ? ` · 抄送 ${m.cc.map((t) => t.name ? `${t.name} <${t.address}>` : t.address).join(', ')}` : ''}
                      </span>
                    ) : (
                      <>发送至 {summarizeRecipients(m)}{m.cc.length ? ` · 抄送 ${m.cc.length} 人` : ''}</>
                    )}
                  </button>
                </div>
              </div>

              {body.data?.hasRemoteImages && !showImages ? (
                <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[8px] bg-warning-soft px-3.5 py-2.5 text-[13px]">
                  <ShieldAlert className="h-4 w-4 shrink-0 text-warning" />
                  <span className="text-secondary">已阻止远程图片以保护隐私</span>
                  <div className="ml-auto flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setShowImages(true)}>显示图片</Button>
                    {m.fromAddr ? <Button size="sm" variant="ghost" onClick={() => { trustSender(m.fromAddr!); setShowImages(true); }}>始终显示此发件人</Button> : null}
                  </div>
                </div>
              ) : null}

              <div className="mt-6">
                {body.isLoading ? (
                  <BodySkeleton />
                ) : body.isError ? (
                  <div className="rounded-[8px] bg-danger-soft px-3.5 py-3 text-[13px] text-danger">
                    正文加载失败：{(body.error as Error).message}
                    <Button size="sm" variant="ghost" className="ml-2" onClick={() => body.refetch()}>重试</Button>
                  </div>
                ) : body.data ? (
                  <BodyFrame html={body.data.html} text={body.data.text} showRemoteImages={showImages} />
                ) : null}
              </div>

              {m.attachments.filter((a) => !a.isInline).length ? <Attachments m={m} /> : null}
            </>
          )}
        </article>
      </div>
    </div>
  );
}

function summarizeRecipients(m: MessageDetail): string {
  if (!m.to.length) return '—';
  const first = m.to[0]!;
  const label = first.name || first.address;
  return m.to.length > 1 ? `${label} 等 ${m.to.length} 人` : label;
}

function Toolbar({ m, onBack, onPatch, onDelete }: { m: MessageDetail | undefined; onBack?: () => void; onPatch: (p: { seen?: boolean; flagged?: boolean }) => void; onDelete: () => void }) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-1 border-b border-subtle px-3">
      {onBack ? (
        <IconButton label="返回" onClick={onBack} className="mr-1 md:hidden">
          <ArrowLeft className="h-4 w-4" />
        </IconButton>
      ) : null}
      <Tooltip content={m?.seen ? '标为未读 (u)' : '标为已读 (u)'}>
        <IconButton label="已读状态" disabled={!m} onClick={() => m && onPatch({ seen: !m.seen })}>
          {m?.seen ? <Mail className="h-4 w-4" /> : <MailOpen className="h-4 w-4" />}
        </IconButton>
      </Tooltip>
      <Tooltip content={m?.flagged ? '取消星标 (s)' : '星标 (s)'}>
        <IconButton label="星标" disabled={!m} onClick={() => m && onPatch({ flagged: !m.flagged })}>
          <Star className={cn('h-4 w-4', m?.flagged && 'fill-c-amber text-c-amber')} />
        </IconButton>
      </Tooltip>
      <Tooltip content="删除 (#)">
        <IconButton label="删除" disabled={!m} onClick={onDelete} className="hover:bg-danger-soft hover:text-danger">
          <Trash2 className="h-4 w-4" />
        </IconButton>
      </Tooltip>
      <div className="flex-1" />
      {m && m.threadCount > 1 ? <span className="text-[12px] text-muted">同一会话还有 {m.threadCount - 1} 封</span> : null}
    </div>
  );
}

function Attachments({ m }: { m: MessageDetail }) {
  const list = m.attachments.filter((a) => !a.isInline);
  return (
    <section className="mt-8">
      <h3 className="mb-2.5 flex items-center gap-1.5 text-[12px] font-medium uppercase tracking-wider text-muted">
        <Paperclip className="h-3.5 w-3.5" /> 附件 ({list.length})
      </h3>
      <div className="grid gap-2.5 sm:grid-cols-2">
        {list.map((a) => <AttachmentCard key={a.id} m={m} a={a} />)}
      </div>
    </section>
  );
}

function AttachmentCard({ m, a }: { m: MessageDetail; a: AttachmentInfo }) {
  const isImage = (a.contentType ?? '').startsWith('image/');
  const Icon = isImage ? ImageIcon : FileText;
  const url = api.messages.attachmentUrl(m.id, a.id);
  const [preview, setPreview] = useState(false);
  return (
    <>
      <div className="flex items-center gap-3 rounded-[10px] bg-inset p-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface text-secondary shadow-sm">
          <Icon className="h-4.5 w-4.5" strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-medium">{a.filename || '未命名附件'}</p>
          <p className="tnum text-[12px] text-muted">{formatSize(a.size)}{a.contentType ? ` · ${a.contentType.split('/')[1]?.toUpperCase()}` : ''}</p>
        </div>
        {isImage ? (
          <Tooltip content="预览">
            <IconButton label="预览" onClick={() => setPreview(true)}><Eye className="h-4 w-4" /></IconButton>
          </Tooltip>
        ) : null}
        <Tooltip content="下载">
          <a href={url} download={a.filename ?? undefined} className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] text-secondary hover:bg-hover hover:text-primary" aria-label="下载">
            <Download className="h-4 w-4" />
          </a>
        </Tooltip>
      </div>
      {preview ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6 animate-fade-in" onClick={() => setPreview(false)}>
          <img src={api.messages.attachmentUrl(m.id, a.id, true)} alt={a.filename ?? ''} className="max-h-full max-w-full rounded-md shadow-lg" />
        </div>
      ) : null}
    </>
  );
}

function HeaderSkeleton() {
  return (
    <div>
      <Skeleton className="h-6 w-2/3" />
      <div className="mt-5 flex gap-3">
        <Skeleton className="h-9 w-9 rounded-full" />
        <div className="flex-1 space-y-2"><Skeleton className="h-3.5 w-48" /><Skeleton className="h-3 w-32" /></div>
      </div>
      <BodySkeleton />
    </div>
  );
}

function BodySkeleton() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShow(true), 200);
    return () => clearTimeout(t);
  }, []);
  if (!show) return <div className="mt-6 h-24" />;
  return (
    <div className="mt-6 space-y-3">
      <Skeleton className="h-3.5 w-[90%]" />
      <Skeleton className="h-3.5 w-full" />
      <Skeleton className="h-3.5 w-[60%]" />
    </div>
  );
}

