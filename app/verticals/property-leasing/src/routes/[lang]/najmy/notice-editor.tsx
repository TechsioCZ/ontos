// An e-mail or SMS text prepared from a template and stored with the record (S10); nothing is sent from here. The
// editor opens with the first template's text, which Uložit can store at once but which is not typed input; picking a
// template or typing changes only the draft; the shared Uložit stores it once and starts the editor over; Enter never
// stores; leaving the page with typed input asks first.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { SaveBar, UnsavedChangesDialog, saveLabelsFor, useDraftSave, useUnsavedChangesGuard } from '@app/admin-ui';
import {
  ChoiceField,
  ChoiceLensField,
  FormReact,
  FormRoot,
  SuggestedTextAreaField,
  SuggestedTextField,
  fromPayload,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Effect, Option, PlatformError, Schema, Struct } from 'effect';
import { constVoid } from 'effect/Function';
import { Atom } from 'effect/reactivity';
import { useEffect, useState } from 'react';
import { OccupancyCommandSchema } from '../../../../shared/actions/apply-command.ts';
import type { Feedback } from '../../../../shared/actions/apply-command.ts';
import {
  NoticeChannelSchema,
  NoticeTemplateKeySchema,
  PreparedNoticeIdSchema,
} from '../../../../shared/apis/records.ts';
import { additionSaveOutcome } from './occupancy-command.ts';
import type { AdditionSave } from './occupancy-command.ts';
import { browserAtomRuntime, browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
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

const PrepareNoticeSchema = OccupancyCommandSchema.pipe(Schema.toTaggedUnion('_tag')).cases.PrepareNotice;
/** The notice as Uložit would store it: the payload of PrepareNotice without the record and the new id. */
const NoticeDraftSchema = PrepareNoticeSchema.mapFields(
  Struct.pick(['body', 'channel', 'recipient', 'subject', 'templateKey']),
);
type NoticeDraft = typeof NoticeDraftSchema.Encoded;
const decodesAsNotice = (draft: NoticeDraft) => Option.isSome(Schema.decodeUnknownOption(NoticeDraftSchema)(draft));

/** Nothing is stored yet, so the opening text is a draft Uložit sends. */
const nothingStored: NoticeDraft = { body: '', channel: 'EMAIL', recipient: '', subject: '', templateKey: '' };

/**
 * What the person chose and typed. The template and channel come from the payload; a text that is `null` still
 * follows the template (and the recipient the record's contact), so names and contacts that finish loading after the
 * editor mounted replace the interim placeholder instead of freezing it in the draft. Enter never stores: only Uložit
 * does, through the shared save.
 */
const noticeForm = FormReact.make(
  fromPayload(PrepareNoticeSchema.mapFields(Struct.pick(['channel', 'templateKey'])))
    .addField('body', Schema.OptionFromNullOr(Schema.String))
    .addField('recipient', Schema.OptionFromNullOr(Schema.String))
    .addField('subject', Schema.OptionFromNullOr(Schema.String)),
  {
    fields: {
      body: SuggestedTextAreaField,
      channel: ChoiceLensField<NoticeChannel>,
      recipient: SuggestedTextField,
      subject: SuggestedTextField,
      templateKey: ChoiceField,
    },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);
type NoticeValues = typeof noticeForm.schema.Encoded;

const pickedText = <A,>(value: Atom.Atom<Option.Option<A>>) => value.pipe(Atom.map(Option.getOrNull));
/** The picked template and channel as plain values that change only when the person picks another one. */
const pickedTemplate = pickedText(noticeForm.getFieldAtoms(noticeForm.fields.templateKey).value);
const pickedChannel = pickedText(noticeForm.getFieldAtoms(noticeForm.fields.channel).value);
const bodyField = noticeForm.getFieldAtoms(noticeForm.fields.body);
const recipientField = noticeForm.getFieldAtoms(noticeForm.fields.recipient);
const subjectField = noticeForm.getFieldAtoms(noticeForm.fields.subject);

const channels = [
  { label: 'E-mail', value: 'EMAIL' },
  { label: 'SMS', value: 'SMS' },
];
/** The channel picked in the list; a choice that is no channel keeps the current one. */
const channelChoice = {
  read: (channel: NoticeChannel) => channel,
  write: (channel: NoticeChannel, choice: string) =>
    Option.getOrElse(Schema.decodeUnknownOption(NoticeChannelSchema)(choice), () => channel),
};

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
  const opening: NoticeValues = {
    body: null,
    channel: 'EMAIL',
    recipient: null,
    subject: null,
    templateKey: templates[0]?.key ?? '',
  };
  const values = Option.getOrElse(useAtomValue(noticeForm.values), () => opening);
  const reset = useAtomSet(noticeForm.reset);
  const setBody = useAtomSet(bodyField.setValue);
  const setRecipient = useAtomSet(recipientField.setValue);
  const setSubject = useAtomSet(subjectField.setValue);
  // Another template starts its text over; another channel also its default recipient.
  useAtomSubscribe(
    pickedTemplate,
    () => {
      setBody(null);
      setSubject(null);
    },
    { immediate: false },
  );
  useAtomSubscribe(
    pickedChannel,
    () => {
      setBody(null);
      setRecipient(null);
      setSubject(null);
    },
    { immediate: false },
  );
  // The text last copied: the button says so while it is still the text on screen.
  const [copied, setCopied] = useState<string | null>(null);
  /** The template's text and the record's contact for the chosen template and channel. */
  const suggestionOf = (from: NoticeValues): NoticeDraft => {
    const template = templates.find((item) => item.key === from.templateKey) ?? templates[0];
    const rendered = template?.render(context, from.channel) ?? { body: '', subject: '' };
    return {
      body: rendered.body,
      channel: from.channel,
      recipient: from.channel === 'SMS' ? defaultPhone : defaultEmail,
      subject: rendered.subject,
      templateKey: template?.key ?? '',
    };
  };
  const resolve = (from: NoticeValues): NoticeDraft => {
    const suggested = suggestionOf(from);
    return {
      ...suggested,
      body: from.body ?? suggested.body,
      recipient: from.recipient ?? suggested.recipient,
      subject: from.subject ?? suggested.subject,
    };
  };
  const suggestion = suggestionOf(values);
  const draft = resolve(values);
  // Typing either text freezes both at what is shown: the other one stops following the template too, until another
  // template or channel, or starting over, puts both back.
  const followsBody = values.body === null;
  const followsSubject = values.subject === null;
  useEffect(() => {
    if (followsBody && !followsSubject) {
      setBody(suggestion.body);
    } else if (followsSubject && !followsBody) {
      setSubject(suggestion.subject);
    }
  }, [followsBody, followsSubject, setBody, setSubject, suggestion.body, suggestion.subject]);
  const [reason, setReason] = useState(() => Option.none<Feedback>());
  const record = useDraftSave<NoticeDraft, never>({
    initial: nothingStored,
    isValid: (value) =>
      decodesAsNotice(value) &&
      noticeRecipientError(value.recipient, value.channel) === undefined &&
      noticeBodyError(value.body, value.channel) === undefined,
    opened: resolve(opening),
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
    reset();
    setCopied(null);
  };
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({ draft: record, navigation: blocker, onDiscard: startOver });
  const showProblems = record.status === 'invalid';
  const recipientError = noticeRecipientError(draft.recipient, draft.channel);
  const bodyError = noticeBodyError(draft.body, draft.channel);
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
  const copiedText = draft.channel === 'EMAIL' ? `${draft.subject}\n\n${draft.body}` : draft.body;
  const handleCopy = () => {
    const { clipboard } = globalThis.navigator;
    if (clipboard === undefined) {
      return;
    }
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
        Effect.tap(() => Effect.sync(() => setCopied(copiedText))),
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
    <>
      <FormRoot
        className="sp-tenant-stack"
        defaultValues={opening}
        form={noticeForm}
        translateMessage={() => t('property-leasing.demo.feedback.validation')}
      >
        <div className="sp-tenant-fields">
          <noticeForm.templateKey
            items={templates.map((item) => ({ label: item.label, value: item.key }))}
            label={t('property-leasing.notices.template')}
          />
          <noticeForm.channel items={channels} label={t('property-leasing.notices.channel')} {...channelChoice} />
        </div>
        <noticeForm.recipient
          id="notice-recipient"
          label={draft.channel === 'EMAIL' ? 'E-mail příjemce' : 'Telefon příjemce'}
          suggestion={suggestion.recipient}
          type={draft.channel === 'EMAIL' ? 'email' : 'tel'}
          {...(showProblems && recipientError !== undefined ? { helpText: recipientError, invalid: true } : {})}
        />
        {draft.channel === 'EMAIL' && (
          <noticeForm.subject
            id="notice-subject"
            label={t('property-leasing.related.contractSubject')}
            maxLength={200}
            suggestion={suggestion.subject}
          />
        )}
        <noticeForm.body
          id="notice-body"
          invalid={showProblems && bodyError !== undefined}
          label={t('property-leasing.notices.body')}
          maxLength={2000}
          rows={draft.channel === 'SMS' ? 4 : 10}
          suggestion={suggestion.body}
        />
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
          <Button appearance="outline" onClick={handleCopy} severity="secondary" size="sm">
            {copied === copiedText ? 'Zkopírováno' : 'Zkopírovat text'}
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
      </FormRoot>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};
