import { DetailList, SectionCard, formatDate } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Effect, type PlatformError } from 'effect';
import { useState } from 'react';
import type {
  Occupancy,
  OccupancyHistoryEntry,
  PreparedNotice,
  RegistrationOccupant,
  RegistrationSheet,
} from '../../../../../shared/apis/records.ts';
import type { OccupancyCommand } from '../../../../../shared/actions/apply-command.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { smsSegments, templatesFor } from './notice-templates.ts';
import type { NoticeChannel, NoticeContext } from './notice-templates.ts';
import { formatInstant, principalLabel } from './principal-labels.ts';
import './tenant-dossier.css';

const historyLabels = {
  CREATED: 'Založení',
  UPDATED: 'Úprava',
  RENT_TERMS: 'Nájemné',
  CONFIRMED: 'Potvrzení',
  ACTIVATED: 'Zahájení',
  COMPLETED: 'Ukončení',
  CANCELLED: 'Zrušení',
  IMPORTED: 'Import',
  REGISTRATION_SHEET: 'Evidenční list',
  NOTICE: 'Oznámení',
} as const;

/** S10-02: every state change of the stay or lease with its author and time; cancelled records keep it. */
export const OccupancyHistoryCard = ({ entries }: { readonly entries: readonly OccupancyHistoryEntry[] }) => (
  <div className="sp-tenant">
    <SectionCard title="Historie změn">
      {entries.length === 0 ? (
        <p className="sp-tenant-muted">
          Záznam vznikl před zavedením historie změn. Další změny stavu se zde zobrazí s autorem a časem.
        </p>
      ) : (
        entries.toReversed().map((entry, index) => (
          <article className="sp-tenant-event" key={`${entry.occurredAt}:${index}`}>
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

const purposes = ['Rekreace', 'Služební cesta', 'Bydlení – nájem', 'Podnikání – nájem', 'Jiný účel'] as const;
const emptyOccupant = (name = ''): RegistrationOccupant => ({
  name,
  birthDate: null,
  nationality: 'Česká republika',
  identityDocument: '',
  address: '',
});
const escapeHtml = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const day = (value: string | null) => (value === null ? 'bez konce' : formatDate(value));

const printSheet = (sheet: RegistrationSheet, context: NoticeContext) => {
  const rows = sheet.occupants
    .map(
      (occupant, index) =>
        `<tr><td>${index + 1}</td><td>${escapeHtml(occupant.name)}</td><td>${
          occupant.birthDate === null ? '' : escapeHtml(formatDate(occupant.birthDate))
        }</td><td>${escapeHtml(occupant.nationality)}</td><td>${escapeHtml(occupant.identityDocument)}</td><td>${escapeHtml(
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
    `${formatDate(sheet.startDate)} – ${day(sheet.endDate)}`,
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
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 60_000);
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
  const { record } = context;
  const initialCount = Math.min(Math.max(record.peopleCount ?? 1, 1), 20);
  const [open, setOpen] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [occupants, setOccupants] = useState<readonly RegistrationOccupant[]>(() =>
    Array.from({ length: initialCount }, (_, index) =>
      emptyOccupant(index === 0 && record.kind === 'SHORT_STAY' ? context.partyName : ''),
    ),
  );
  const [purpose, setPurpose] = useState<string>(record.kind === 'SHORT_STAY' ? 'Rekreace' : 'Bydlení – nájem');
  const [note, setNote] = useState('');
  const allowed = record.state !== 'DRAFT' && record.state !== 'CANCELLED';
  const nameError = (occupant: RegistrationOccupant) =>
    submitted && occupant.name.trim().length === 0 ? 'Vyplňte jméno a příjmení ubytovaného.' : undefined;
  const update = (index: number, field: keyof RegistrationOccupant, value: string) =>
    setOccupants(
      occupants.map((occupant, position) =>
        position === index
          ? { ...occupant, [field]: field === 'birthDate' ? (value === '' ? null : value) : value }
          : occupant,
      ),
    );
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
        title="Evidenční list"
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
                { label: 'Období', value: `${formatDate(sheet.startDate)} – ${day(sheet.endDate)}` },
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
          <form
            className="sp-tenant-stack"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              setSubmitted(true);
              if (occupants.some((occupant) => occupant.name.trim().length === 0)) return;
              void browserRuntime.runPromiseExit(
                newId.pipe(
                  Effect.tap((sheetId) =>
                    Effect.sync(() =>
                      onCommand({
                        _tag: 'CreateRegistrationSheet',
                        occupancyRef: record.occupancyRef,
                        sheetId,
                        occupants: occupants.map((occupant) => ({
                          ...occupant,
                          name: occupant.name.trim(),
                          nationality: occupant.nationality.trim(),
                          identityDocument: occupant.identityDocument.trim(),
                          address: occupant.address.trim(),
                        })),
                        purpose,
                        note: note.trim(),
                      }),
                    ),
                  ),
                ),
              );
            }}
          >
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
              <fieldset className="sp-tenant-contact" key={index}>
                <legend>Ubytovaná osoba {index + 1}</legend>
                <div className="sp-tenant-fields">
                  <FormInput
                    id={`sheet-name-${index}`}
                    label="Jméno a příjmení"
                    maxLength={200}
                    onChange={(event) => update(index, 'name', event.target.value)}
                    value={occupant.name}
                    {...(nameError(occupant) === undefined
                      ? {}
                      : { validateStatus: 'error' as const, helpText: nameError(occupant) })}
                  />
                  <FormInput
                    label="Datum narození"
                    onChange={(event) => update(index, 'birthDate', event.target.value)}
                    type="date"
                    value={occupant.birthDate ?? ''}
                  />
                  <FormInput
                    label="Státní občanství"
                    maxLength={200}
                    onChange={(event) => update(index, 'nationality', event.target.value)}
                    value={occupant.nationality}
                  />
                  <FormInput
                    label="Číslo dokladu totožnosti"
                    maxLength={200}
                    onChange={(event) => update(index, 'identityDocument', event.target.value)}
                    value={occupant.identityDocument}
                  />
                </div>
                <FormInput
                  label="Adresa trvalého pobytu"
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
                onClick={() => setOccupants([...occupants, emptyOccupant()])}
                size="sm"
                theme="outlined"
                variant="secondary"
              >
                Přidat osobu
              </Button>
              <label className="sp-tenant-stack">
                <span>Účel pobytu</span>
                <select aria-label="Účel pobytu" onChange={(event) => setPurpose(event.target.value)} value={purpose}>
                  {purposes.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <FormInput
              label="Poznámka (nepovinné)"
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
  const templates = templatesFor(context.record.kind);
  const [templateKey, setTemplateKey] = useState(templates[0]?.key ?? '');
  const [channel, setChannel] = useState<NoticeChannel>('EMAIL');
  const template = templates.find((item) => item.key === templateKey) ?? templates[0];
  const initial = template?.render(context, 'EMAIL') ?? { subject: '', body: '' };
  const [subject, setSubject] = useState(initial.subject);
  const [body, setBody] = useState(initial.body);
  const [recipient, setRecipient] = useState(defaultEmail);
  const [copied, setCopied] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const applyTemplate = (key: string, nextChannel: NoticeChannel) => {
    const next = templates.find((item) => item.key === key)?.render(context, nextChannel);
    setTemplateKey(key);
    setChannel(nextChannel);
    setSubject(next?.subject ?? '');
    setBody(next?.body ?? '');
    setCopied(false);
  };
  const recipientError =
    recipient.trim() !== '' && !(channel === 'EMAIL' ? emailPattern : phonePattern).test(recipient.trim())
      ? channel === 'EMAIL'
        ? 'Zadejte e-mail ve tvaru jmeno@firma.cz.'
        : 'Zadejte telefon, například +420 777 123 456.'
      : undefined;
  const bodyError =
    body.trim().length === 0
      ? 'Text oznámení nesmí být prázdný.'
      : channel === 'SMS' && body.length > 480
        ? 'Text SMS může mít nejvýše 480 znaků.'
        : undefined;
  const mailto = `mailto:${encodeURIComponent(recipient.trim())}?subject=${encodeURIComponent(
    subject,
  )}&body=${encodeURIComponent(body)}`;
  return (
    <div className="sp-tenant">
      <SectionCard title="Oznámení e-mailem nebo SMS">
        <p className="sp-tenant-muted">
          Text připravíte ze šablony a upravíte. Uložený text zůstane u záznamu s autorem a časem. Nic se odsud
          automaticky neodesílá; SMS lze odesílat až po napojení potvrzeného poskytovatele.
        </p>
        {canWrite && template !== undefined && (
          <form
            className="sp-tenant-stack"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              setSubmitted(true);
              if (recipientError !== undefined || bodyError !== undefined) return;
              void browserRuntime.runPromiseExit(
                newId.pipe(
                  Effect.tap((noticeId) =>
                    Effect.sync(() =>
                      onCommand({
                        _tag: 'PrepareNotice',
                        occupancyRef: context.record.occupancyRef,
                        noticeId,
                        channel,
                        templateKey: template.key,
                        recipient: recipient.trim(),
                        subject: channel === 'SMS' ? '' : subject.trim(),
                        body: body.trim(),
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
                  aria-label="Šablona oznámení"
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
                  aria-label="Kanál oznámení"
                  onChange={(event) => {
                    const next = event.target.value === 'SMS' ? 'SMS' : 'EMAIL';
                    setRecipient(next === 'SMS' ? defaultPhone : defaultEmail);
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
              onChange={(event) => setRecipient(event.target.value)}
              type={channel === 'EMAIL' ? 'email' : 'tel'}
              value={recipient}
              {...(submitted && recipientError !== undefined
                ? { validateStatus: 'error' as const, helpText: recipientError }
                : {})}
            />
            {channel === 'EMAIL' && (
              <FormInput
                label="Předmět"
                maxLength={200}
                onChange={(event) => setSubject(event.target.value)}
                value={subject}
              />
            )}
            <label className="sp-tenant-stack">
              <span>Text oznámení</span>
              <textarea
                aria-invalid={submitted && bodyError !== undefined}
                aria-label="Text oznámení"
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
                  void globalThis.navigator.clipboard
                    ?.writeText(channel === 'EMAIL' ? `${subject}\n\n${body}` : body)
                    .then(() => setCopied(true));
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
        )}
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
