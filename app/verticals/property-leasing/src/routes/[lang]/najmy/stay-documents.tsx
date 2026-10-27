import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { DetailList, SectionCard, formatDate } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Effect, Option, PlatformError } from 'effect';
import { useRef, useState } from 'react';
import type { SubmitEvent } from 'react';
import type {
  OccupancyHistoryEntry,
  PreparedNotice,
  RegistrationOccupant,
  RegistrationSheet,
} from '../../../../shared/apis/records.ts';
import type { OccupancyCommand } from '../../../../shared/actions/apply-command.ts';
import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { smsSegments, templatesFor } from './notice-templates.ts';
import type { NoticeChannel, NoticeContext } from './notice-templates.ts';
import { formatInstant, principalLabel } from './principal-labels.ts';
import './tenant-dossier.css';
import { timelineEntries } from './timeline-entries.ts';
import {
  NoticeTemplateKeySchema,
  PreparedNoticeIdSchema,
  RegistrationSheetIdSchema,
} from '../../../../shared/apis/records.ts';

const historyLabels = {
  ACTIVATED: 'Zahájení',
  CANCELLED: 'Zrušení',
  COMPLETED: 'Ukončení',
  CONFIRMED: 'Potvrzení',
  CREATED: 'Založení',
  IMPORTED: 'Import',
  NOTICE: 'Oznámení',
  REGISTRATION_SHEET: 'Evidenční list',
  RENT_TERMS: 'Nájemné',
  UPDATED: 'Úprava',
} as const;

/** S10-02: every state change of the stay or lease with its author and time; cancelled records keep it. */
export const OccupancyHistoryCard = ({ entries }: { readonly entries: readonly OccupancyHistoryEntry[] }) => {
  const { t } = useModernI18n();
  return (
    <div className="sp-tenant">
      <SectionCard title={t('property-leasing.documents.historyTitle')}>
        {entries.length === 0 ? (
          <p className="sp-tenant-muted">
            Záznam vznikl před zavedením historie změn. Další změny stavu se zde zobrazí s autorem a časem.
          </p>
        ) : (
          timelineEntries(entries).map(({ entry, key }) => (
            <article className="sp-tenant-event" key={key}>
              <div className="sp-tenant-heading">
                <Badge size="sm" variant={entry.kind === 'CANCELLED' ? 'danger' : 'outline'}>
                  {historyLabels[entry.kind]}
                </Badge>
                <span className="sp-tenant-muted">
                  {principalLabel(entry.authorPrincipalId)} · {formatInstant(entry.occurredAt)}
                </span>
              </div>
              <p>{entry.summary}</p>
            </article>
          ))
        )}
      </SectionCard>
    </div>
  );
};

const purposes = ['Rekreace', 'Služební cesta', 'Bydlení – nájem', 'Podnikání – nájem', 'Jiný účel'] as const;
const emptyOccupant = (name = ''): RegistrationOccupant => ({
  address: '',
  birthDate: Option.none(),
  identityDocument: '',
  name,
  nationality: 'Česká republika',
});
interface OccupantDraft extends RegistrationOccupant {
  readonly localKey: string;
}
const storedOccupant = (occupant: OccupantDraft): RegistrationOccupant => ({
  address: occupant.address.trim(),
  birthDate: occupant.birthDate,
  identityDocument: occupant.identityDocument.trim(),
  name: occupant.name.trim(),
  nationality: occupant.nationality.trim(),
});
const escapeHtml = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const day = (value: string | null) => (value === null ? 'bez konce' : formatDate(value));

const printSheet = (sheet: RegistrationSheet, context: NoticeContext) => {
  const rows = sheet.occupants
    .map(
      (occupant, index) =>
        `<tr><td>${index + 1}</td><td>${escapeHtml(occupant.name)}</td><td>${Option.match(occupant.birthDate, {
          onNone: () => '',
          onSome: (date) => escapeHtml(formatDate(date)),
        })}</td><td>${escapeHtml(occupant.nationality)}</td><td>${escapeHtml(occupant.identityDocument)}</td><td>${escapeHtml(
          occupant.address,
        )}</td></tr>`,
    )
    .join('');
  const html = `<!doctype html><html lang="cs"><head><meta charset="utf-8"><title>Evidenční list ${escapeHtml(
    sheet.number,
  )}</title><style>body{font:13px system-ui,sans-serif;margin:32px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:6px;text-align:left}h1{font-size:20px}dl{display:grid;grid-template-columns:12rem 1fr;gap:4px 12px}</style></head><body><h1>Evidenční list ${escapeHtml(
    sheet.number,
  )}</h1><dl><dt>Ubytovatel</dt><dd>Siampark</dd><dt>Jednotka</dt><dd>${escapeHtml(
    [context.unitLabel, context.propertyLabel, context.propertyAddress].filter((part) => part !== '').join(', '),
  )}</dd><dt>Rezervace / nájem</dt><dd>${escapeHtml(context.partyName)}</dd><dt>Období</dt><dd>${escapeHtml(
    `${formatDate(sheet.startDate)} – ${day(Option.getOrNull(sheet.endDate))}`,
  )}</dd><dt>Účel pobytu</dt><dd>${escapeHtml(sheet.purpose)}</dd><dt>Založil</dt><dd>${escapeHtml(
    `${principalLabel(sheet.authorPrincipalId)}, ${formatInstant(sheet.createdAt)}`,
  )}</dd></dl><table><thead><tr><th>#</th><th>Jméno a příjmení</th><th>Datum narození</th><th>Státní občanství</th><th>Číslo dokladu</th><th>Adresa trvalého pobytu</th></tr></thead><tbody>${rows}</tbody></table>${
    sheet.note === '' ? '' : `<p>Poznámka: ${escapeHtml(sheet.note)}</p>`
  }<p style="margin-top:48px">Podpis ubytovaného: ______________________</p></body></html>`;
  // A standalone printable page; the browser's print dialog opens once it has loaded.
  const url = URL.createObjectURL(
    new Blob([html.replace('</body>', '<script>window.onload = () => window.print();</script></body>')], {
      type: 'text/html;charset=utf-8',
    }),
  );
  globalThis.open(url, '_blank', 'noopener');
};

/** S10: registration sheet created from the reservation or lease, with the people actually staying. */
export const RegistrationSheetCard = ({
  busy,
  canWrite,
  context,
  newId,
  onCommand,
  sheets,
}: {
  readonly busy: boolean;
  readonly canWrite: boolean;
  readonly context: NoticeContext;
  readonly newId: Effect.Effect<string, PlatformError.PlatformError>;
  readonly onCommand: (command: OccupancyCommand) => void;
  readonly sheets: readonly RegistrationSheet[];
}) => {
  const { t } = useModernI18n();
  const { record } = context;
  const initialCount = Math.min(Math.max(record.peopleCount ?? 1, 1), 20);
  const [open, setOpen] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [occupants, setOccupants] = useState<readonly OccupantDraft[]>(() =>
    Array.from({ length: initialCount }, (_, index) => ({
      ...emptyOccupant(index === 0 && record.kind === 'SHORT_STAY' ? context.partyName : ''),
      localKey: `initial-${index}`,
    })),
  );
  const occupantSequence = useRef(initialCount);
  const addOccupant = () => {
    const localKey = `added-${occupantSequence.current}`;
    occupantSequence.current += 1;
    setOccupants((previous) => [...previous, { ...emptyOccupant(), localKey }]);
  };
  const [purpose, setPurpose] = useState<string>(() => {
    if (record.kind === 'SHORT_STAY') {
      return 'Rekreace';
    }
    return context.unitLabel.startsWith('Byt') ? 'Bydlení – nájem' : 'Podnikání – nájem';
  });
  const [note, setNote] = useState('');
  const allowed = record.state !== 'DRAFT' && record.state !== 'CANCELLED';
  const nameError = (occupant: RegistrationOccupant) =>
    submitted && occupant.name.trim().length === 0 ? 'Vyplňte jméno a příjmení ubytovaného.' : undefined;
  const update = (index: number, field: keyof RegistrationOccupant, value: string) =>
    setOccupants(
      occupants.map((occupant, position) => {
        if (position !== index) {
          return occupant;
        }
        if (field === 'birthDate') {
          return { ...occupant, birthDate: value === '' ? Option.none() : Option.some(value) };
        }
        return { ...occupant, [field]: value };
      }),
    );
  const handleSheetSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitted(true);
    if (occupants.some((occupant) => occupant.name.trim().length === 0)) {
      return;
    }
    void browserRuntime.runPromiseExit(
      newId.pipe(
        Effect.tap((sheetId) =>
          Effect.sync(() =>
            onCommand({
              _tag: 'CreateRegistrationSheet',
              note: note.trim(),
              occupancyRef: record.occupancyRef,
              occupants: occupants.map(storedOccupant),
              purpose,
              sheetId: RegistrationSheetIdSchema.make(sheetId),
            }),
          ),
        ),
      ),
    );
  };
  return (
    <div className="sp-tenant">
      <SectionCard
        actions={
          canWrite && allowed && !open ? (
            <Button disabled={busy} onClick={() => setOpen(true)} size="sm" variant="primary">
              Založit evidenční list
            </Button>
          ) : undefined
        }
        title={t('property-leasing.registration.title')}
      >
        <p className="sp-tenant-muted">
          Evidenční list přebírá jednotku, období a počet osob z této{' '}
          {record.kind === 'SHORT_STAY' ? 'rezervace' : 'smlouvy'}; doplníte údaje skutečně ubytovaných osob. Uložený
          list se pozdější změnou rezervace nepřepíše.
        </p>
        {!allowed && (
          <p className="sp-tenant-muted">
            {record.state === 'DRAFT'
              ? 'Evidenční list lze založit po potvrzení rezervace nebo nájmu.'
              : 'Ke zrušené rezervaci se evidenční list nezakládá.'}
          </p>
        )}
        {sheets.length === 0 && allowed && <p className="sp-tenant-muted">Zatím nebyl založen žádný evidenční list.</p>}
        {sheets.toReversed().map((sheet) => (
          <article className="sp-tenant-contact" key={sheet.sheetId}>
            <div className="sp-tenant-heading">
              <strong>{sheet.number}</strong>
              <Button onClick={() => printSheet(sheet, context)} size="sm" theme="outlined" variant="secondary">
                Vytisknout
              </Button>
            </div>
            <DetailList
              items={[
                { label: 'Období', value: `${formatDate(sheet.startDate)} – ${day(Option.getOrNull(sheet.endDate))}` },
                { label: 'Účel pobytu', value: sheet.purpose || 'Neuvedeno' },
                { label: 'Ubytovaní', value: sheet.occupants.map((occupant) => occupant.name).join(', ') },
                {
                  label: 'Založil',
                  value: `${principalLabel(sheet.authorPrincipalId)} · ${formatInstant(sheet.createdAt)}`,
                },
              ]}
            />
          </article>
        ))}
        {open && canWrite && (
          <form className="sp-tenant-stack" noValidate onSubmit={handleSheetSubmit}>
            <DetailList
              items={[
                { label: 'Jednotka', value: [context.unitLabel, context.propertyLabel].join(', ') },
                { label: 'Období', value: `${formatDate(record.startDate)} – ${day(record.endDate)}` },
                {
                  label: record.kind === 'SHORT_STAY' ? 'Host' : 'Nájemce',
                  value: context.partyName,
                },
              ]}
            />
            {occupants.map((occupant, index) => (
              <fieldset className="sp-tenant-contact" key={occupant.localKey}>
                <legend>Ubytovaná osoba {index + 1}</legend>
                <div className="sp-tenant-fields">
                  <FormInput
                    id={`sheet-name-${index}`}
                    label={t('property-leasing.registration.fullName')}
                    maxLength={200}
                    onChange={(event) => update(index, 'name', event.target.value)}
                    value={occupant.name}
                    {...(nameError(occupant) === undefined
                      ? {}
                      : { helpText: nameError(occupant), validateStatus: 'error' as const })}
                  />
                  <FormInput
                    label={t('property-leasing.registration.birthDate')}
                    onChange={(event) => update(index, 'birthDate', event.target.value)}
                    type="date"
                    value={Option.getOrElse(occupant.birthDate, () => '')}
                  />
                  <FormInput
                    label={t('property-leasing.registration.nationality')}
                    maxLength={200}
                    onChange={(event) => update(index, 'nationality', event.target.value)}
                    value={occupant.nationality}
                  />
                  <FormInput
                    label={t('property-leasing.registration.identityDocument')}
                    maxLength={200}
                    onChange={(event) => update(index, 'identityDocument', event.target.value)}
                    value={occupant.identityDocument}
                  />
                </div>
                <FormInput
                  label={t('property-leasing.registration.permanentAddress')}
                  maxLength={300}
                  onChange={(event) => update(index, 'address', event.target.value)}
                  value={occupant.address}
                />
                {occupants.length > 1 && (
                  <Button
                    onClick={() => setOccupants(occupants.filter((_, position) => position !== index))}
                    size="sm"
                    theme="borderless"
                    variant="secondary"
                  >
                    Odebrat osobu
                  </Button>
                )}
              </fieldset>
            ))}
            <div className="sp-tenant-actions">
              <Button
                disabled={occupants.length >= 20}
                onClick={() => addOccupant()}
                size="sm"
                theme="outlined"
                variant="secondary"
              >
                Přidat osobu
              </Button>
              <label className="sp-tenant-stack">
                <span>Účel pobytu</span>
                <select
                  aria-label={t('property-leasing.registration.purpose')}
                  onChange={(event) => setPurpose(event.target.value)}
                  value={purpose}
                >
                  {purposes.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <FormInput
              label={t('property-leasing.registration.optionalNote')}
              maxLength={500}
              onChange={(event) => setNote(event.target.value)}
              value={note}
            />
            {submitted && occupants.some((occupant) => occupant.name.trim().length === 0) && (
              <p className="sp-tenant-muted" role="alert">
                Doplňte jméno a příjmení u všech ubytovaných osob.
              </p>
            )}
            <div className="sp-tenant-actions">
              <Button disabled={busy} size="sm" type="submit" variant="primary">
                Uložit evidenční list
              </Button>
              <Button disabled={busy} onClick={() => setOpen(false)} size="sm" theme="outlined" variant="secondary">
                Zrušit
              </Button>
            </div>
          </form>
        )}
      </SectionCard>
    </div>
  );
};

const channelLabels = { EMAIL: 'E-mail', SMS: 'SMS' } as const;
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
const useNoticeEditor = (context: NoticeContext, defaultEmail: string, defaultPhone: string) => {
  const templates = templatesFor(context.record.kind);
  const [templateKey, setTemplateKey] = useState(templates[0]?.key ?? '');
  const [channel, setChannel] = useState<NoticeChannel>('EMAIL');
  const template = templates.find((item) => item.key === templateKey) ?? templates[0];
  // The text stays derived from the template until the user edits it, so names, contacts and the unit that
  // finish loading after the card mounted replace the interim placeholder instead of freezing it in the draft.
  const rendered = template?.render(context, channel) ?? { body: '', subject: '' };
  const [draft, setDraft] = useState<{ readonly body: string; readonly subject: string }>();
  const subject = draft?.subject ?? rendered.subject;
  const body = draft?.body ?? rendered.body;
  const [recipientDraft, setRecipientDraft] = useState<string>();
  const recipient = recipientDraft ?? (channel === 'SMS' ? defaultPhone : defaultEmail);
  const setSubject = (value: string) => setDraft({ body, subject: value });
  const setBody = (value: string) => setDraft({ body: value, subject });
  const [copied, setCopied] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const applyTemplate = (key: string, nextChannel: NoticeChannel) => {
    setTemplateKey(key);
    setChannel(nextChannel);
    setDraft(undefined);
    setCopied(false);
  };
  const recipientError = noticeRecipientError(recipient, channel);
  const bodyError = noticeBodyError(body, channel);
  const mailto = `mailto:${encodeURIComponent(recipient.trim())}?subject=${encodeURIComponent(
    subject,
  )}&body=${encodeURIComponent(body)}`;
  return {
    applyTemplate,
    body,
    bodyError,
    channel,
    copied,
    mailto,
    recipient,
    recipientError,
    setBody,
    setCopied,
    setRecipientDraft,
    setSubject,
    setSubmitted,
    subject,
    submitted,
    template,
    templates,
  };
};
const NoticeEditor = ({
  busy,
  context,
  editor,
  newId,
  onCommand,
}: {
  readonly busy: boolean;
  readonly context: NoticeContext;
  readonly editor: ReturnType<typeof useNoticeEditor>;
  readonly newId: Effect.Effect<string, PlatformError.PlatformError>;
  readonly onCommand: (command: OccupancyCommand) => void;
}) => {
  const {
    applyTemplate,
    body,
    bodyError,
    channel,
    copied,
    mailto,
    recipient,
    recipientError,
    setBody,
    setCopied,
    setRecipientDraft,
    setSubject,
    setSubmitted,
    subject,
    submitted,
    template,
    templates,
  } = editor;
  const { t } = useModernI18n();
  if (template === undefined) {
    return null;
  }
  return (
    <form
      className="sp-tenant-stack"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
        if (recipientError !== undefined || bodyError !== undefined) {
          return;
        }
        void browserRuntime.runPromiseExit(
          newId.pipe(
            Effect.tap((noticeId) =>
              Effect.sync(() =>
                onCommand({
                  _tag: 'PrepareNotice',
                  body: body.trim(),
                  channel,
                  noticeId: PreparedNoticeIdSchema.make(noticeId),
                  occupancyRef: context.record.occupancyRef,
                  recipient: recipient.trim(),
                  subject: channel === 'SMS' ? '' : subject.trim(),
                  templateKey: NoticeTemplateKeySchema.make(template.key),
                }),
              ),
            ),
          ),
        );
      }}
    >
      <div className="sp-tenant-fields">
        <label className="sp-tenant-stack">
          <span>Šablona</span>
          <select
            aria-label={t('property-leasing.notices.template')}
            onChange={(event) => applyTemplate(event.target.value, channel)}
            value={template.key}
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
            onChange={(event) => {
              const next = event.target.value === 'SMS' ? 'SMS' : 'EMAIL';
              setRecipientDraft(undefined);
              applyTemplate(template.key, next);
            }}
            value={channel}
          >
            <option value="EMAIL">E-mail</option>
            <option value="SMS">SMS</option>
          </select>
        </label>
      </div>
      <FormInput
        label={channel === 'EMAIL' ? 'E-mail příjemce' : 'Telefon příjemce'}
        onChange={(event) => setRecipientDraft(event.target.value)}
        type={channel === 'EMAIL' ? 'email' : 'tel'}
        value={recipient}
        {...(submitted && recipientError !== undefined
          ? { helpText: recipientError, validateStatus: 'error' as const }
          : {})}
      />
      {channel === 'EMAIL' && (
        <FormInput
          label={t('property-leasing.related.contractSubject')}
          maxLength={200}
          onChange={(event) => setSubject(event.target.value)}
          value={subject}
        />
      )}
      <label className="sp-tenant-stack">
        <span>Text oznámení</span>
        <textarea
          aria-invalid={submitted && bodyError !== undefined}
          aria-label={t('property-leasing.notices.body')}
          className="sp-notice-text"
          maxLength={2000}
          onChange={(event) => {
            setBody(event.target.value);
            setCopied(false);
          }}
          rows={channel === 'SMS' ? 4 : 10}
          value={body}
        />
      </label>
      <span className="sp-tenant-muted">
        {channel === 'SMS'
          ? `${body.length} znaků · ${smsSegments(body)} SMS (text s diakritikou se počítá po 70 znacích)`
          : `${body.length} znaků`}
      </span>
      {submitted && bodyError !== undefined && (
        <p className="sp-tenant-muted" role="alert">
          {bodyError}
        </p>
      )}
      <div className="sp-tenant-actions">
        <Button disabled={busy} size="sm" type="submit" variant="primary">
          Uložit připravený text
        </Button>
        <Button
          onClick={() => {
            const { clipboard } = globalThis.navigator;
            if (clipboard === undefined) {
              return;
            }
            const copiedText = channel === 'EMAIL' ? `${subject}\n\n${body}` : body;
            void browserRuntime.runPromiseExit(
              Effect.tryPromise({
                catch: (cause) =>
                  PlatformError.systemError({ _tag: 'Unknown', cause, method: 'writeText', module: 'Clipboard' }),
                try: clipboard.writeText.bind(clipboard, copiedText),
              }).pipe(
                Effect.timeoutOrElse({
                  duration: '5 seconds',
                  orElse: () =>
                    Effect.fail(
                      PlatformError.systemError({ _tag: 'TimedOut', method: 'writeText', module: 'Clipboard' }),
                    ),
                }),
                Effect.tap(() => Effect.sync(() => setCopied(true))),
              ),
            );
          }}
          size="sm"
          theme="outlined"
          variant="secondary"
        >
          {copied ? 'Zkopírováno' : 'Zkopírovat text'}
        </Button>
        {channel === 'EMAIL' && (
          <a className="sp-tenant-muted" href={mailto}>
            Otevřít v poštovním programu →
          </a>
        )}
      </div>
    </form>
  );
};

/** S10: notification text prepared from a template and stored with the record. Nothing is sent from here. */
export const NoticeCard = ({
  busy,
  canWrite,
  context,
  defaultEmail,
  defaultPhone,
  newId,
  notices,
  onCommand,
}: {
  readonly busy: boolean;
  readonly canWrite: boolean;
  readonly context: NoticeContext;
  readonly defaultEmail: string;
  readonly defaultPhone: string;
  readonly newId: Effect.Effect<string, PlatformError.PlatformError>;
  readonly notices: readonly PreparedNotice[];
  readonly onCommand: (command: OccupancyCommand) => void;
}) => {
  const { t } = useModernI18n();
  const editor = useNoticeEditor(context, defaultEmail, defaultPhone);
  const { templates } = editor;
  return (
    <div className="sp-tenant">
      <SectionCard title={t('property-leasing.notices.title')}>
        <p className="sp-tenant-muted">
          Text připravíte ze šablony a upravíte. Uložený text zůstane u záznamu s autorem a časem. Nic se odsud
          automaticky neodesílá; SMS lze odesílat až po napojení potvrzeného poskytovatele.
        </p>
        {canWrite && <NoticeEditor busy={busy} context={context} editor={editor} newId={newId} onCommand={onCommand} />}
        <h3>Připravená oznámení</h3>
        {notices.length === 0 && <p className="sp-tenant-muted">Zatím nebylo připraveno žádné oznámení.</p>}
        {notices.toReversed().map((notice) => (
          <article className="sp-tenant-event" key={notice.noticeId}>
            <div className="sp-tenant-heading">
              <span className="sp-tenant-actions">
                <Badge size="sm" variant="outline">
                  {channelLabels[notice.channel]}
                </Badge>
                <Badge size="sm" variant="warning">
                  Neodesláno
                </Badge>
              </span>
              <span className="sp-tenant-muted">
                {principalLabel(notice.authorPrincipalId)} · {formatInstant(notice.preparedAt)}
              </span>
            </div>
            <p className="sp-tenant-muted">
              {templates.find((item) => item.key === notice.templateKey)?.label ?? 'Šablona'} · příjemce{' '}
              {notice.recipient === '' ? 'neuveden' : notice.recipient}
            </p>
            {notice.subject !== '' && <strong>{notice.subject}</strong>}
            <p className="sp-notice-body">{notice.body}</p>
          </article>
        ))}
      </SectionCard>
    </div>
  );
};
