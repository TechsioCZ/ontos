import { Effect } from 'effect';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
// Reusable persistent comment thread (S14) — OWNED BY THE documents LANE (ops-documents). Embed anywhere inside
// AgendaFrame:   <CommentThread subject={{ kind: 'task', id: task.id, label: task.title }} />
// Comments are stored in the `documents` agenda (restricted): only roles with read_all see them; the server never
// returns them to the external persona. Author/time are set by the server; edits keep the previous wording.
import { optionalField } from '../../shared/domain/common.ts';
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
import { formatWhen, isoOf } from './documents-kit.tsx';
import { LoadingSkeleton } from './loading-skeleton.tsx';
import { useAgendaRecords } from './use-agenda.ts';
import type { CommandOutcome, FailureReason } from './use-agenda.ts';
import { surfaceTileClassName } from '@app/admin-ui';

const k = 'facility-operations.documents.comments';
const NO_ATTACHMENT = '__none__';

/** Highlights @mentions in a comment body. */
const renderBody = (body: string): ReactNode =>
  body.split(/(?<mention>@[\p{L}\p{N}._-]+)/u).map((part, index) =>
    part.startsWith('@') ? (
      <span className="rounded-sm bg-primary-light px-50 font-medium" key={`${index}-${part}`}>
        {part}
      </span>
    ) : (
      <Fragment key={`${index}-${part}`}>{part}</Fragment>
    ),
  );

const mentionsOf = (body: string) => [
  ...new Set(
    [...body.matchAll(/@(?<name>[\p{L}\p{N}._-]+)/gu)].flatMap((match) => {
      const name = match.groups?.['name'];
      return name === undefined || name === '' ? [] : [name];
    }),
  ),
];

export interface CommentThreadProps {
  /** Offer a link to a stored document in the composer (S14.R2). Default: true for chat. */
  readonly allowAttachment?: boolean;
  /** Render nothing (instead of a quiet note) when the viewer may not read comments. */
  readonly hideWhenForbidden?: boolean;
  /** Called when the user clicks a linked document chip. */
  readonly onOpenAttachment?: (attachment: SubjectRef) => void;
  /**
   * Optional: the page's own `useAgendaRecords([...,'documents'])` result, so the page and the thread share one
   * documents revision (avoids a stale-revision conflict when the page also writes documents).
   */
  readonly records?: ReturnType<typeof useAgendaRecords>;
  /** The record the thread belongs to: `{ kind, id, label }` (label is a display snapshot). */
  readonly subject: SubjectRef;
  /** Heading; defaults to „Komentáře“. Pass `null` to hide the heading row. */
  readonly title?: string | null;
  /** `chat` renders a conversation (send button wording, composer at the bottom, taller list). */
  readonly variant?: 'thread' | 'chat';
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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [showHistory, setShowHistory] = useState(false);
  const [confirmRetract, setConfirmRetract] = useState(false);
  const [busy, setBusy] = useState(false);
  const mine = meId !== undefined && comment.createdBy.principalId === meId;
  const retracted = comment.retractedAt !== undefined;

  const fail = (reason: FailureReason) =>
    toast.create({ title: t(`facility-operations.common.errors.${reason}`), type: 'error' });

  const finishSave = (outcome: CommandOutcome) =>
    Effect.sync(() => {
      setBusy(false);
      if (outcome.ok) {
        setEditing(false);
        toast.create({ title: t('facility-operations.common.saved'), type: 'success' });
      } else {
        fail(outcome.reason);
      }
    });
  const finishRetract = (outcome: CommandOutcome) =>
    Effect.sync(() => {
      setBusy(false);
      setConfirmRetract(false);
      if (!outcome.ok) {
        fail(outcome.reason);
      }
    });
  const saveEdit = (): Effect.Effect<void> =>
    Effect.suspend(() => {
      const body = draft.trim();
      if (body === '' || body === comment.body) {
        return Effect.sync(() => setEditing(false));
      }
      setBusy(true);
      return run({ _tag: 'DocumentCommentEdit', body, commentId: comment.id }).pipe(
        Effect.tap(finishSave),
        Effect.asVoid,
      );
    });

  const retract = (): Effect.Effect<void> =>
    Effect.suspend(() => {
      setBusy(true);
      return run({ _tag: 'DocumentCommentRetract', commentId: comment.id }).pipe(
        Effect.tap(finishRetract),
        Effect.asVoid,
      );
    });

  return (
    <li className="flex gap-150" data-comment-id={comment.id}>
      <div className="flex min-w-0 flex-1 flex-col gap-50">
        <div className="flex flex-wrap items-baseline gap-x-100 gap-y-50">
          {mine && <span className="font-semibold text-sm">{t(`${k}.you`)}</span>}
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
        {retracted && (
          <p className="text-fg-secondary text-sm italic">
            {t(`${k}.retracted`, { when: formatWhen(comment.retractedAt ?? comment.updatedAt) })}
          </p>
        )}
        {!retracted && editing && (
          <div className="flex flex-col gap-100">
            <Textarea
              aria-label={t(`${k}.edit`)}
              maxLength={4000}
              onChange={(event) => setDraft(event.target.value)}
              rows={3}
              value={draft}
            />
            <div className="flex gap-100">
              <Button
                isLoading={busy}
                onClick={() => {
                  browserRuntime.runFork(saveEdit());
                }}
                size="sm"
                variant="primary"
              >
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
        )}
        {!retracted && !editing && (
          <div className="whitespace-pre-wrap break-words rounded-md bg-highlight px-150 py-100 text-sm">
            {renderBody(comment.body)}
          </div>
        )}
        {comment.attachment !== undefined && !retracted && (
          <button
            className="inline-flex w-fit items-center gap-50 rounded-md border border-border-primary bg-surface px-100 py-50 text-xs hover:bg-highlight"
            onClick={() => {
              if (comment.attachment === undefined) {
                return;
              }
              if (onOpenAttachment !== undefined) {
                onOpenAttachment(comment.attachment);
              } else if (comment.attachment.kind === 'document') {
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
                <Button
                  isLoading={busy}
                  onClick={() => {
                    browserRuntime.runFork(retract());
                  }}
                  size="sm"
                  variant="danger"
                >
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

const threadViewOf = (ops: ReturnType<typeof useAgendaRecords>, subject: SubjectRef) => {
  const envelope = ops.data?.agendas.documents;
  const state: DocumentsState | undefined = envelope?.state;
  const comments = (state?.comments ?? [])
    .filter((comment) => sameSubject(comment.subject, subject))
    .toSorted((left, right) => isoOf(left.createdAt).localeCompare(isoOf(right.createdAt)));
  return state === undefined
    ? undefined
    : {
        canWrite: envelope?.canWrite === true,
        comments,
        documents: state.documents.filter((document) => !(subject.kind === 'document' && document.id === subject.id)),
        meId: ops.data?.actorPrincipalRef.principalId,
        visibleCount: comments.filter((comment) => comment.retractedAt === undefined).length,
      };
};

const postCommentCommand = (
  text: string,
  context: {
    readonly attachment: string;
    readonly documents: DocumentsState['documents'];
    readonly subject: SubjectRef;
  },
) => {
  const linked = context.documents.find((document) => document.id === context.attachment);
  const mentions = mentionsOf(text);
  return {
    _tag: 'DocumentCommentPost' as const,
    body: text,
    subject: context.subject,
    ...optionalField(
      'attachment',
      linked === undefined ? undefined : { id: linked.id, kind: 'document' as const, label: linked.title },
    ),
    ...optionalField('mentions', mentions.length === 0 ? undefined : mentions),
  };
};

const threadPresentation = (variant: 'thread' | 'chat') =>
  variant === 'chat'
    ? { attachments: true, listClassName: 'max-h-[60vh] overflow-y-auto pr-100', rows: 2 }
    : { attachments: false, listClassName: '', rows: 3 };

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
  const view = threadViewOf(ops, subject);
  const [body, setBody] = useState('');
  const [attachment, setAttachment] = useState(NO_ATTACHMENT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FailureReason | undefined>();
  const presentation = threadPresentation(variant);
  const withAttachment = allowAttachment ?? presentation.attachments;
  const heading = title ?? t(`${k}.title`);

  if (ops.status === 'loading') {
    return <LoadingSkeleton rows={2} />;
  }
  if (ops.status !== 'ready' || view === undefined) {
    return hideWhenForbidden ? null : (
      <p className="rounded-md border border-border-primary border-dashed px-200 py-150 text-fg-secondary text-sm">
        {ops.status === 'error' ? t('facility-operations.common.states.errorTitle') : t(`${k}.forbidden`)}
      </p>
    );
  }

  const { canWrite, comments, documents, meId, visibleCount } = view;
  const finishPost = (outcome: CommandOutcome) =>
    Effect.sync(() => {
      setBusy(false);
      if (outcome.ok) {
        setBody('');
        setAttachment(NO_ATTACHMENT);
        toast.create({ title: t(`${k}.posted`), type: 'success' });
      } else {
        setError(outcome.reason);
      }
    });
  const submit = (): Effect.Effect<void> =>
    Effect.suspend(() => {
      const text = body.trim();
      if (text === '' || busy) {
        return Effect.void;
      }
      setBusy(true);
      setError(undefined);
      return ops
        .run(postCommentCommand(text, { attachment, documents, subject }))
        .pipe(Effect.tap(finishPost), Effect.asVoid);
    });

  return (
    <section aria-label={heading} className="flex flex-col gap-200" data-testid="comment-thread">
      {title !== null && (
        <div className="flex items-center justify-between gap-100">
          <h3 className="font-semibold text-md">{heading}</h3>
          <Badge size="sm" variant="outline">
            {t(`${k}.count`, { count: visibleCount })}
          </Badge>
        </div>
      )}
      {comments.length === 0 ? (
        <p className="text-fg-secondary text-sm">{t(`${k}.empty`)}</p>
      ) : (
        <ol className={`flex flex-col gap-250 ${presentation.listClassName}`}>
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
                browserRuntime.runFork(submit());
              }
            }}
            placeholder={t(`${k}.placeholder`)}
            rows={presentation.rows}
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
              onClick={() => {
                browserRuntime.runFork(submit());
              }}
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
