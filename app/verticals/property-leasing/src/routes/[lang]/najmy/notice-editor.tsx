// An e-mail or SMS text prepared from a template and stored with the record (S10); nothing is sent from here. The
// editor opens with the first template's text, which Uložit can store at once but which is not typed input; picking a
// template or typing changes only the draft; the shared Uložit stores it once and starts the editor over; Enter never
// stores; leaving the page with typed input asks first.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { SaveBar, UnsavedChangesDialog, saveLabelsFor, useDraftSave, useUnsavedChangesGuard } from '@app/admin-ui';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Effect, Option, PlatformError } from 'effect';
import { constVoid } from 'effect/Function';
import { useState } from 'react';
import { NoticeTemplateKeySchema, PreparedNoticeIdSchema } from '../../../../shared/apis/records.ts';
import type { Feedback } from '../../../../shared/actions/apply-command.ts';
import { additionSaveOutcome } from './occupancy-command.ts';
import type { AdditionSave } from './occupancy-command.ts';
import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { smsSegments, templatesFor } from './notice-templates.ts';
import type { NoticeChannel, NoticeContext } from './notice-templates.ts';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const phonePattern = /^\+?[0-9 ]{9,20}$/u;

const noticeRecipientError = (recipient: string, channel: NoticeChannel): string | undefined => {
  if (recipient.trim() === '' || (channel === 'EMAIL' ? emailPattern : phonePattern).test(recipient.trim())) {
    return undefined;
  }
  return channel === 'EMAIL'
    ? 'Zadejte e-mail ve tvaru jmeno@firma.cz.'
    : 'Zadejte telefon, například +420 777 123 456.';
};
const noticeBodyError = (body: string, channel: NoticeChannel): string | undefined => {
  if (body.trim().length === 0) {
    return 'Text oznámení nesmí být prázdný.';
  }
  if (channel === 'SMS' && body.length > 480) {
    return 'Text SMS může mít nejvýše 480 znaků.';
  }
  return undefined;
};

/** What the person chose and typed; an absent text still follows the template. */
interface NoticeChoice {
  readonly channel: NoticeChannel;
  readonly edited?: { readonly body: string; readonly subject: string } | undefined;
  readonly recipient?: string | undefined;
  readonly templateKey: string;
}

/** The notice as Uložit would store it. */
interface NoticeDraft {
  readonly body: string;
  readonly channel: NoticeChannel;
  readonly recipient: string;
  readonly subject: string;
  readonly templateKey: string;
}

/** Nothing is stored yet, so the opening text is a draft Uložit sends. */
const nothingStored: NoticeDraft = { body: '', channel: 'EMAIL', recipient: '', subject: '', templateKey: '' };

export const NoticeEditor = ({
  context,
  defaultEmail,
  defaultPhone,
  newId,
  onSave,
}: {
  readonly context: NoticeContext;
  readonly defaultEmail: string;
  readonly defaultPhone: string;
  readonly newId: Effect.Effect<string, PlatformError.PlatformError>;
  /** Sends the command that stores the notice, once. */
  readonly onSave: AdditionSave;
}) => {
  const { language, t } = useModernI18n();
  const labels = saveLabelsFor(language);
  const templates = templatesFor(context.record.kind);
  const firstChoice: NoticeChoice = { channel: 'EMAIL', templateKey: templates[0]?.key ?? '' };
  const [choice, setChoice] = useState<NoticeChoice>(firstChoice);
  const [copied, setCopied] = useState(false);
  // The text follows the template until it is edited, so names and contacts that finish loading after the editor
  // mounted replace the interim placeholder instead of freezing it in the draft.
  const resolve = (from: NoticeChoice): NoticeDraft => {
    const template = templates.find((item) => item.key === from.templateKey) ?? templates[0];
    const rendered = template?.render(context, from.channel) ?? { body: '', subject: '' };
    return {
      body: from.edited?.body ?? rendered.body,
      channel: from.channel,
      recipient: from.recipient ?? (from.channel === 'SMS' ? defaultPhone : defaultEmail),
      subject: from.edited?.subject ?? rendered.subject,
      templateKey: template?.key ?? '',
    };
  };
  const draft = resolve(choice);
  const [reason, setReason] = useState(() => Option.none<Feedback>());
  const record = useDraftSave<NoticeDraft, never>({
    initial: nothingStored,
    isValid: (value) =>
      noticeRecipientError(value.recipient, value.channel) === undefined &&
      noticeBodyError(value.body, value.channel) === undefined,
    opened: resolve(firstChoice),
    runtime: browserRuntime,
    save: (value) =>
      additionSaveOutcome(
        newId.pipe(
          Effect.flatMap((noticeId) =>
            onSave({
              _tag: 'PrepareNotice',
              body: value.body.trim(),
              channel: value.channel,
              noticeId: PreparedNoticeIdSchema.make(noticeId),
              occupancyRef: context.record.occupancyRef,
              recipient: value.recipient.trim(),
              subject: value.channel === 'SMS' ? '' : value.subject.trim(),
              templateKey: NoticeTemplateKeySchema.make(value.templateKey),
            }),
          ),
        ),
        setReason,
      ),
    value: draft,
  });
  const startOver = () => {
    setChoice(firstChoice);
    setCopied(false);
  };
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({ draft: record, navigation: blocker, onDiscard: startOver });
  const showProblems = record.status === 'invalid';
  const recipientError = noticeRecipientError(draft.recipient, draft.channel);
  const bodyError = noticeBodyError(draft.body, draft.channel);
  const edit = (patch: { readonly body?: string; readonly subject?: string }) => {
    setCopied(false);
    setChoice((current) => ({
      ...current,
      edited: { body: patch.body ?? draft.body, subject: patch.subject ?? draft.subject },
    }));
  };
  /** Another template or channel starts its text over; another channel also its default recipient. */
  const applyTemplate = (templateKey: string, channel: NoticeChannel, recipient?: string) => {
    setCopied(false);
    setChoice({ channel, recipient, templateKey });
  };
  const handleSave = () => {
    record.save();
    // A stored text is listed below: the editor starts over from the first template.
    record.afterSave((status) => {
      if (status === 'saved') {
        startOver();
        record.adopt(nothingStored);
      }
    });
  };
  const handleCopy = () => {
    const { clipboard } = globalThis.navigator;
    if (clipboard === undefined) {
      return;
    }
    const copiedText = draft.channel === 'EMAIL' ? `${draft.subject}\n\n${draft.body}` : draft.body;
    browserRuntime.runFork(
      Effect.tryPromise({
        catch: (cause) =>
          PlatformError.systemError({ _tag: 'Unknown', cause, method: 'writeText', module: 'Clipboard' }),
        try: clipboard.writeText.bind(clipboard, copiedText),
      }).pipe(
        Effect.timeoutOrElse({
          duration: '5 seconds',
          orElse: () =>
            Effect.fail(PlatformError.systemError({ _tag: 'TimedOut', method: 'writeText', module: 'Clipboard' })),
        }),
        Effect.tap(() => Effect.sync(() => setCopied(true))),
        Effect.ignore,
      ),
    );
  };
  if (templates.length === 0) {
    return null;
  }
  const mailto = `mailto:${encodeURIComponent(draft.recipient.trim())}?subject=${encodeURIComponent(
    draft.subject,
  )}&body=${encodeURIComponent(draft.body)}`;
  return (
    <form
      className="sp-tenant-stack"
      noValidate
      onSubmit={(event) => {
        // Enter never stores: only Uložit does.
        event.preventDefault();
      }}
    >
      <div className="sp-tenant-fields">
        <label className="sp-tenant-stack">
          <span>Šablona</span>
          <select
            aria-label={t('property-leasing.notices.template')}
            onChange={(event) => applyTemplate(event.target.value, draft.channel, choice.recipient)}
            value={draft.templateKey}
          >
            {templates.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="sp-tenant-stack">
          <span>Kanál</span>
          <select
            aria-label={t('property-leasing.notices.channel')}
            onChange={(event) => applyTemplate(draft.templateKey, event.target.value === 'SMS' ? 'SMS' : 'EMAIL')}
            value={draft.channel}
          >
            <option value="EMAIL">E-mail</option>
            <option value="SMS">SMS</option>
          </select>
        </label>
      </div>
      <FormInput
        id="notice-recipient"
        label={draft.channel === 'EMAIL' ? 'E-mail příjemce' : 'Telefon příjemce'}
        onChange={(event) => {
          const { value } = event.target;
          setChoice((current) => ({ ...current, recipient: value }));
        }}
        type={draft.channel === 'EMAIL' ? 'email' : 'tel'}
        value={draft.recipient}
        {...(showProblems && recipientError !== undefined
          ? { helpText: recipientError, validateStatus: 'error' as const }
          : {})}
      />
      {draft.channel === 'EMAIL' && (
        <FormInput
          id="notice-subject"
          label={t('property-leasing.related.contractSubject')}
          maxLength={200}
          onChange={(event) => edit({ subject: event.target.value })}
          value={draft.subject}
        />
      )}
      <label className="sp-tenant-stack">
        <span>Text oznámení</span>
        <textarea
          aria-invalid={showProblems && bodyError !== undefined}
          aria-label={t('property-leasing.notices.body')}
          className="sp-notice-text"
          id="notice-body"
          maxLength={2000}
          onChange={(event) => edit({ body: event.target.value })}
          rows={draft.channel === 'SMS' ? 4 : 10}
          value={draft.body}
        />
      </label>
      <span className="sp-tenant-muted">
        {draft.channel === 'SMS'
          ? `${draft.body.length} znaků · ${smsSegments(draft.body)} SMS (text s diakritikou se počítá po 70 znacích)`
          : `${draft.body.length} znaků`}
      </span>
      {showProblems && bodyError !== undefined && (
        <p className="sp-tenant-muted" role="alert">
          {bodyError}
        </p>
      )}
      <div className="sp-tenant-actions">
        <Button onClick={handleCopy} size="sm" theme="outlined" variant="secondary">
          {copied ? 'Zkopírováno' : 'Zkopírovat text'}
        </Button>
        {draft.channel === 'EMAIL' && (
          <a className="sp-tenant-muted" href={mailto}>
            Otevřít v poštovním programu →
          </a>
        )}
        <SaveBar
          error={Option.match(reason, {
            onNone: () => null,
            onSome: (value) => t(`property-leasing.demo.feedback.${value}`),
          })}
          labels={labels}
          onReloadLatest={constVoid}
          onSave={handleSave}
          size="sm"
          status={record.status}
        />
      </div>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </form>
  );
};
