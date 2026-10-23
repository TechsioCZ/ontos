// @effect-diagnostics asyncFunction:off
// Reusable persistent comment thread (S14) — OWNED BY THE documents LANE (ops-documents). Embed anywhere inside
// AgendaFrame:   <CommentThread subject={{ kind: 'task', id: task.id, label: task.title }} />
// Comments are stored in the `documents` agenda (restricted): only roles with read_all see them; the server never
// returns them to the external persona. Author/time are set by the server; edits keep the previous wording.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Textarea } from '@techsio/ui-kit/atoms/textarea';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { SelectTemplate as Select } from '@techsio/ui-kit/templates/select';
import { Fragment, useState } from 'react';
import type { ReactNode } from 'react';
import type { CommentRecord, DocumentsState, SubjectRef } from '../../shared/domain/documents.ts';
import { sameSubject } from '../../shared/domain/documents.ts';
import { formatWhen, isoOf, PrincipalAvatar, principalEmail, usePrincipalLabel } from './documents-kit.tsx';
import { LoadingSkeleton } from './loading-skeleton.tsx';
import { useAgendaRecords } from './use-agenda.ts';
import type { FailureReason } from './use-agenda.ts';
import { surfaceTileClassName } from '@app/admin-ui';

const k = 'facility-operations.documents.comments';
const NO_ATTACHMENT = '__none__';

/** Highlights @mentions in a comment body. */
const renderBody = (body: string): ReactNode =>
  body.split(/(@[\p{L}\p{N}._-]+)/u).map((part, index) =>
    part.startsWith('@') ? (
      <span className="rounded-sm bg-primary-light px-50 font-medium" key={`${index}-${part}`}>
        {part}
      </span>
    ) : (
      <Fragment key={`${index}-${part}`}>{part}</Fragment>
    ),
  );

const mentionsOf = (body: string) => [
  ...new Set([...body.matchAll(/@([\p{L}\p{N}._-]+)/gu)].map((match) => match[1] ?? '').filter((name) => name !== '')),
];

export interface CommentThreadProps {
  /** The record the thread belongs to: `{ kind, id, label }` (label is a display snapshot). */
  readonly subject: SubjectRef;
  /** Heading; defaults to „Komentáře“. Pass `null` to hide the heading row. */
  readonly title?: string | null;
  /** `chat` renders a conversation (send button wording, composer at the bottom, taller list). */
  readonly variant?: 'thread' | 'chat';
  /** Offer a link to a stored document in the composer (S14.R2). Default: true for chat. */
  readonly allowAttachment?: boolean;
  /** Called when the user clicks a linked document chip. */
  readonly onOpenAttachment?: (attachment: SubjectRef) => void;
  /** Render nothing (instead of a quiet note) when the viewer may not read comments. */
  readonly hideWhenForbidden?: boolean;
  /**
   * Optional: the page's own `useAgendaRecords([...,'documents'])` result, so the page and the thread share one
   * documents revision (avoids a stale-revision conflict when the page also writes documents).
   */
  readonly records?: ReturnType<typeof useAgendaRecords>;
}

const CommentItem = ({
  canWrite,
  comment,
  meId,
  onOpenAttachment,
  run,
}: {
  readonly canWrite: boolean;
  readonly comment: CommentRecord;
  readonly meId: string | undefined;
  readonly onOpenAttachment: ((attachment: SubjectRef) => void) | undefined;
  readonly run: ReturnType<typeof useAgendaRecords>['run'];
}) => {
  const { language, t } = useModernI18n();
  const toast = useToast();
  const principalLabel = usePrincipalLabel();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [showHistory, setShowHistory] = useState(false);
  const [confirmRetract, setConfirmRetract] = useState(false);
  const [busy, setBusy] = useState(false);
  const author = principalLabel(comment.createdBy);
  const mine = meId !== undefined && comment.createdBy.principalId === meId;
  const retracted = comment.retractedAt !== undefined;

  const fail = (reason: FailureReason) =>
    toast.create({ title: t(`facility-operations.common.errors.${reason}`), type: 'error' });

  const saveEdit = async () => {
    const body = draft.trim();
    if (body === '' || body === comment.body) {
      setEditing(false);
      return;
    }
    setBusy(true);
    const outcome = await run({ _tag: 'DocumentCommentEdit', body, commentId: comment.id });
    setBusy(false);
    if (outcome.ok) {
      setEditing(false);
      toast.create({ title: t('facility-operations.common.saved'), type: 'success' });
    } else {
      fail(outcome.reason);
    }
  };

  const retract = async () => {
    setBusy(true);
    const outcome = await run({ _tag: 'DocumentCommentRetract', commentId: comment.id });
    setBusy(false);
    setConfirmRetract(false);
    if (!outcome.ok) {
      fail(outcome.reason);
    }
  };

  return (
    <li className="flex gap-150" data-comment-id={comment.id}>
      <PrincipalAvatar label={author} principal={comment.createdBy} />
      <div className="flex min-w-0 flex-1 flex-col gap-50">
        <div className="flex flex-wrap items-baseline gap-x-100 gap-y-50">
          <span className="font-semibold text-sm" title={principalEmail(comment.createdBy)}>
            {author}
            {mine && <span className="font-normal text-fg-secondary"> ({t(`${k}.you`)})</span>}
          </span>
          <time className="text-fg-secondary text-xs" dateTime={isoOf(comment.createdAt)}>
            {formatWhen(comment.createdAt)}
          </time>
          {comment.edits.length > 0 && !retracted && (
            <button
              className="text-fg-secondary text-xs underline decoration-dotted hover:text-fg-primary"
              onClick={() => setShowHistory((value) => !value)}
              type="button"
            >
              {t(`${k}.edited`)} · {formatWhen(comment.updatedAt)}
            </button>
          )}
        </div>
        {retracted ? (
          <p className="text-fg-secondary text-sm italic">
            {t(`${k}.retracted`, { when: formatWhen(comment.retractedAt ?? comment.updatedAt) })}
          </p>
        ) : editing ? (
          <div className="flex flex-col gap-100">
            <Textarea
              aria-label={t(`${k}.edit`)}
              maxLength={4000}
              onChange={(event) => setDraft(event.target.value)}
              rows={3}
              value={draft}
            />
            <div className="flex gap-100">
              <Button isLoading={busy} onClick={() => void saveEdit()} size="sm" variant="primary">
                {t(`${k}.save`)}
              </Button>
              <Button
                onClick={() => {
                  setDraft(comment.body);
                  setEditing(false);
                }}
                size="sm"
                theme="outlined"
                variant="secondary"
              >
                {t(`${k}.cancel`)}
              </Button>
            </div>
          </div>
        ) : (
          <div className="whitespace-pre-wrap break-words rounded-md bg-highlight px-150 py-100 text-sm">
            {renderBody(comment.body)}
          </div>
        )}
        {comment.attachment !== undefined && !retracted && (
          <button
            className="inline-flex w-fit items-center gap-50 rounded-md border border-border-primary bg-surface px-100 py-50 text-xs hover:bg-highlight"
            onClick={() => {
              if (comment.attachment === undefined) return;
              if (onOpenAttachment !== undefined) onOpenAttachment(comment.attachment);
              else if (comment.attachment.kind === 'document') {
                globalThis.location.assign(
                  `/${language ?? 'cs'}/provoz/dokumenty?doc=${encodeURIComponent(comment.attachment.id)}`,
                );
              }
            }}
            type="button"
          >
            <span aria-hidden="true">📎</span>
            <span className="font-medium">{comment.attachment.label}</span>
          </button>
        )}
        {showHistory && (
          <ol className="flex flex-col gap-50 border-border-primary border-l-2 pl-150">
            <li className="font-medium text-fg-secondary text-xs">{t(`${k}.history`)}</li>
            {comment.edits.map((entry) => (
              <li className="text-xs" key={isoOf(entry.editedAt)}>
                <span className="text-fg-secondary">
                  {t(`${k}.historyEntry`, {
                    when: formatWhen(entry.editedAt),
                    who: principalLabel(entry.editedBy),
                  })}
                </span>
                <p className="whitespace-pre-wrap text-fg-secondary line-through">{entry.body}</p>
              </li>
            ))}
          </ol>
        )}
        {mine && canWrite && !retracted && !editing && (
          <div className="flex flex-wrap items-center gap-100">
            <button
              className="text-fg-secondary text-xs hover:text-fg-primary hover:underline"
              onClick={() => setEditing(true)}
              type="button"
            >
              {t(`${k}.edit`)}
            </button>
            {confirmRetract ? (
              <span className="flex items-center gap-100 text-xs">
                <span className="text-fg-secondary">{t(`${k}.retractConfirm`)}</span>
                <Button isLoading={busy} onClick={() => void retract()} size="sm" variant="danger">
                  {t(`${k}.retract`)}
                </Button>
                <Button onClick={() => setConfirmRetract(false)} size="sm" theme="outlined" variant="secondary">
                  {t(`${k}.cancel`)}
                </Button>
              </span>
            ) : (
              <button
                className="text-fg-secondary text-xs hover:text-fg-primary hover:underline"
                onClick={() => setConfirmRetract(true)}
                type="button"
              >
                {t(`${k}.retract`)}
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
};

export const CommentThread = ({
  allowAttachment,
  hideWhenForbidden = false,
  onOpenAttachment,
  records,
  subject,
  title,
  variant = 'thread',
}: CommentThreadProps) => {
  const { t } = useModernI18n();
  const toast = useToast();
  // The page's records when it passes them (same store entry, no second read), else this panel's own documents read.
  const own = useAgendaRecords(['documents'], { enabled: records === undefined });
  const ops = records ?? own;
  const envelope = ops.data?.agendas.documents;
  const state: DocumentsState | undefined = envelope?.state;
  const [body, setBody] = useState('');
  const [attachment, setAttachment] = useState(NO_ATTACHMENT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FailureReason | undefined>(undefined);
  const withAttachment = allowAttachment ?? variant === 'chat';

  if (ops.status === 'loading') {
    return <LoadingSkeleton rows={2} />;
  }
  if (ops.status !== 'ready' || state === undefined) {
    return hideWhenForbidden ? null : (
      <p className="rounded-md border border-border-primary border-dashed px-200 py-150 text-fg-secondary text-sm">
        {ops.status === 'error' ? t('facility-operations.common.states.errorTitle') : t(`${k}.forbidden`)}
      </p>
    );
  }

  const comments = (state.comments ?? [])
    .filter((comment) => sameSubject(comment.subject, subject))
    .toSorted((left, right) => isoOf(left.createdAt).localeCompare(isoOf(right.createdAt)));
  const visibleCount = comments.filter((comment) => comment.retractedAt === undefined).length;
  const canWrite = envelope?.canWrite === true;
  const meId = ops.data?.actorPrincipalRef.principalId;
  const documents = state.documents.filter((document) => !(subject.kind === 'document' && document.id === subject.id));

  const submit = async () => {
    const text = body.trim();
    if (text === '' || busy) {
      return;
    }
    setBusy(true);
    setError(undefined);
    const linked = documents.find((document) => document.id === attachment);
    const mentions = mentionsOf(text);
    const outcome = await ops.run({
      _tag: 'DocumentCommentPost',
      body: text,
      subject,
      ...(linked === undefined ? {} : { attachment: { id: linked.id, kind: 'document', label: linked.title } }),
      ...(mentions.length === 0 ? {} : { mentions }),
    });
    setBusy(false);
    if (outcome.ok) {
      setBody('');
      setAttachment(NO_ATTACHMENT);
      toast.create({ title: t(`${k}.posted`), type: 'success' });
    } else {
      setError(outcome.reason);
    }
  };

  return (
    <section aria-label={title ?? t(`${k}.title`)} className="flex flex-col gap-200" data-testid="comment-thread">
      {title !== null && (
        <div className="flex items-center justify-between gap-100">
          <h3 className="font-semibold text-md">{title ?? t(`${k}.title`)}</h3>
          <Badge size="sm" variant="outline">
            {t(`${k}.count`, { count: visibleCount })}
          </Badge>
        </div>
      )}
      {comments.length === 0 ? (
        <p className="text-fg-secondary text-sm">{t(`${k}.empty`)}</p>
      ) : (
        <ol className={`flex flex-col gap-250 ${variant === 'chat' ? 'max-h-[60vh] overflow-y-auto pr-100' : ''}`}>
          {comments.map((comment) => (
            <CommentItem
              canWrite={canWrite}
              comment={comment}
              key={comment.id}
              meId={meId}
              onOpenAttachment={onOpenAttachment}
              run={ops.run}
            />
          ))}
        </ol>
      )}
      {canWrite ? (
        <div className={`${surfaceTileClassName} flex flex-col gap-100 p-150`}>
          {error !== undefined && (
            <StatusText showIcon status="error">
              {t(`facility-operations.common.errors.${error}`)}
            </StatusText>
          )}
          <Textarea
            aria-label={t(`${k}.label`)}
            maxLength={4000}
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder={t(`${k}.placeholder`)}
            rows={variant === 'chat' ? 2 : 3}
            value={body}
          />
          <div className="flex flex-wrap items-end justify-between gap-100">
            {withAttachment && documents.length > 0 ? (
              <div className="min-w-0 flex-1 sm:max-w-sm">
                <Select
                  items={[
                    { displayValue: t(`${k}.noAttachment`), label: t(`${k}.noAttachment`), value: NO_ATTACHMENT },
                    ...documents.map((document) => ({
                      displayValue: document.title,
                      label: document.title,
                      value: document.id,
                    })),
                  ]}
                  label={t(`${k}.attachment`)}
                  name="comment-attachment"
                  onValueChange={({ value }) => setAttachment(value[0] ?? NO_ATTACHMENT)}
                  size="sm"
                  value={[attachment]}
                />
              </div>
            ) : (
              <span />
            )}
            <Button
              disabled={busy || body.trim() === ''}
              isLoading={busy}
              loadingText={t('facility-operations.common.saving')}
              onClick={() => void submit()}
              size="sm"
              variant="primary"
            >
              {variant === 'chat' ? t(`${k}.send`) : t(`${k}.submit`)}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-fg-secondary text-xs">{t(`${k}.readOnly`)}</p>
      )}
    </section>
  );
};
