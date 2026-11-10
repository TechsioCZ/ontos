import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { DetailList, SectionCard, formatDate } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Option } from 'effect';
import type { Effect, PlatformError } from 'effect';
import { useState } from 'react';
import type { SaveOutcome } from '@app/admin-ui';
import type { OccupancyHistoryEntry, PreparedNotice, RegistrationSheet } from '../../../../shared/apis/records.ts';
import { RegistrationSheetForm } from './registration-sheet-form.tsx';
import type { OccupancyCommand } from '../../../../shared/actions/apply-command.ts';
import { templatesFor } from './notice-templates.ts';
import type { NoticeContext } from './notice-templates.ts';
import { NoticeEditor } from './notice-editor.tsx';
import { formatInstant, principalLabel } from './principal-labels.ts';
import './tenant-dossier.css';
import { timelineEntries } from './timeline-entries.ts';

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
  )}</h1><dl><dt>Ubytovatel</dt><dd>Nájempark</dd><dt>Jednotka</dt><dd>${escapeHtml(
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
  onSave,
  sheets,
}: {
  readonly busy: boolean;
  readonly canWrite: boolean;
  readonly context: NoticeContext;
  readonly newId: Effect.Effect<string, PlatformError.PlatformError>;
  /** Uložit of the sheet form: creates the sheet once. */
  readonly onSave: (command: OccupancyCommand) => Effect.Effect<SaveOutcome>;
  readonly sheets: readonly RegistrationSheet[];
}) => {
  const { t } = useModernI18n();
  const { record } = context;
  const [open, setOpen] = useState(false);
  const allowed = record.state !== 'DRAFT' && record.state !== 'CANCELLED';
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
          <RegistrationSheetForm context={context} newId={newId} onClose={() => setOpen(false)} onSave={onSave} />
        )}
      </SectionCard>
    </div>
  );
};

const channelLabels = { EMAIL: 'E-mail', SMS: 'SMS' } as const;
/** S10: notification text prepared from a template and stored with the record. Nothing is sent from here. */
export const NoticeCard = ({
  canWrite,
  context,
  defaultEmail,
  defaultPhone,
  newId,
  notices,
  onSave,
}: {
  readonly canWrite: boolean;
  readonly context: NoticeContext;
  readonly defaultEmail: string;
  readonly defaultPhone: string;
  readonly newId: Effect.Effect<string, PlatformError.PlatformError>;
  readonly notices: readonly PreparedNotice[];
  /** Uložit of the notice editor: stores the prepared text once. */
  readonly onSave: (command: OccupancyCommand) => Effect.Effect<SaveOutcome>;
}) => {
  const { t } = useModernI18n();
  const templates = templatesFor(context.record.kind);
  return (
    <div className="sp-tenant">
      <SectionCard title={t('property-leasing.notices.title')}>
        <p className="sp-tenant-muted">
          Text připravíte ze šablony a upravíte. Uložený text zůstane u záznamu s autorem a časem. Nic se odsud
          automaticky neodesílá; SMS lze odesílat až po napojení potvrzeného poskytovatele.
        </p>
        {canWrite && (
          <NoticeEditor
            context={context}
            defaultEmail={defaultEmail}
            defaultPhone={defaultPhone}
            newId={newId}
            onSave={onSave}
          />
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
