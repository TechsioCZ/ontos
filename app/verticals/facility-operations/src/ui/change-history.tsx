// Per-record change history (S00 audit, S12 contracts, S15): who, when and old → new values.
// Entries are written by the server in the same transaction as the change (shared/domain/change-log.ts).
//   <ChangeHistory entityId={document.id} refreshKey={envelope.revision} />
// @effect-diagnostics asyncFunction:off
import { formatDate, formatDateTime } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { DateTime } from 'effect';
import { useEffect, useState } from 'react';
import type { ChangeEntry, FieldChange } from '../../shared/domain/change-log.ts';
import { usePrincipalLabel } from './documents-kit.tsx';
import { loadRecords } from './use-agenda.ts';

const k = 'facility-operations.common.history';

/** Czech labels of the fields the agendas use most; unknown fields fall back to their key. */
const fieldLabels: Readonly<Record<string, string>> = {
  acquisitionDate: 'Datum pořízení',
  acquisitionMethod: 'Způsob pořízení',
  acquisitionValueMinor: 'Pořizovací hodnota',
  actualAmountMinor: 'Skutečná částka',
  amountTerms: 'Částka / podmínky',
  category: 'Kategorie',
  'contract.amountTerms': 'Částka / podmínky',
  'contract.contractType': 'Typ smlouvy',
  'contract.noticeDate': 'Poslední den výpovědi',
  'contract.noticePeriod': 'Výpovědní lhůta',
  'contract.owner': 'Odpovědná osoba',
  'contract.parties': 'Smluvní strany',
  'contract.status': 'Stav smlouvy',
  'contract.subject': 'Předmět smlouvy',
  'contract.validFrom': 'Platnost od',
  'contract.validTo': 'Platnost do',
  counterparty: 'Protistrana',
  currentValueMinor: 'Aktuální hodnota',
  date: 'Datum',
  deliveries: 'Dodávky',
  description: 'Popis',
  disposal: 'Vyřazení',
  dueDate: 'Termín',
  expectedDate: 'Očekávané dodání',
  inventoryNumber: 'Inventární číslo',
  invoices: 'Faktury',
  kind: 'Druh',
  lines: 'Řádky',
  links: 'Vazby',
  location: 'Umístění',
  name: 'Název',
  nextInspectionDate: 'Příští revize',
  note: 'Poznámka',
  number: 'Číslo',
  owner: 'Vlastník',
  plannedAmountMinor: 'Plánovaná částka',
  plannedDate: 'Plánovaný termín',
  priority: 'Priorita',
  related: 'Vazba',
  responsible: 'Odpovědná osoba',
  serialNumber: 'Výrobní číslo',
  status: 'Stav',
  title: 'Název',
  unit: 'Jednotka',
  validUntil: 'Platnost do',
  valueChanges: 'Změny hodnoty',
  warehouseId: 'Sklad',
};

const valueLabels: Readonly<Record<string, string>> = {
  accepted: 'Přijato',
  active: 'Aktivní',
  approved: 'Schváleno',
  cancelled: 'Zrušeno',
  completed: 'Dokončeno',
  confirmed: 'Potvrzeno',
  disposed: 'Vyřazeno',
  done: 'Hotovo',
  draft: 'Návrh',
  expired: 'Vypršela',
  false: 'Ne',
  high: 'Vysoká',
  in_progress: 'Probíhá',
  invoiced: 'Vyfakturováno',
  low: 'Nízká',
  medium: 'Střední',
  ordered: 'Objednáno',
  partially_delivered: 'Částečně dodáno',
  planned: 'Plánováno',
  received: 'Přijato',
  rejected: 'Zamítnuto',
  sent: 'Odesláno',
  sold: 'Prodáno',
  terminated: 'Ukončená',
  true: 'Ano',
};

const leaf = (field: string) => field.split('.').at(-1) ?? field;

type Load =
  | { readonly status: 'loading' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'ready'; readonly entries: readonly ChangeEntry[] };

export const ChangeHistory = ({
  entityId,
  refreshKey,
}: {
  readonly entityId: string;
  /** Change it (e.g. the agenda revision) to reload after a save. */
  readonly refreshKey?: number | string | DateTime.Utc;
}) => {
  const { language, t } = useModernI18n();
  const principalLabel = usePrincipalLabel();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [showAll, setShowAll] = useState(false);
  const czech = !language.startsWith('en');
  const refreshToken = DateTime.isDateTime(refreshKey) ? DateTime.toEpochMillis(refreshKey) : refreshKey;

  useEffect(() => {
    let alive = true;
    void loadRecords({ agendas: [], historyFor: entityId }).then((outcome) => {
      if (alive) {
        setLoad(outcome.ok ? { entries: outcome.data.history ?? [], status: 'ready' } : { status: 'unavailable' });
      }
    });
    return () => {
      alive = false;
    };
  }, [entityId, refreshToken]);

  const label = (field: string) => (czech ? (fieldLabels[field] ?? fieldLabels[leaf(field)] ?? field) : field);
  const value = (field: string, raw: string | undefined) => {
    if (raw === undefined) {
      return t(`${k}.emptyValue`);
    }
    if (/^#\d+$/u.test(raw)) {
      return t(`${k}.items`, { count: Number(raw.slice(1)) });
    }
    if (/Minor$/u.test(leaf(field)) && /^-?\d+$/u.test(raw)) {
      return new Intl.NumberFormat(czech ? 'cs-CZ' : 'en-GB', { currency: 'CZK', style: 'currency' }).format(
        Number(raw) / 100,
      );
    }
    if (/^\d{4}-\d{2}-\d{2}$/u.test(raw)) {
      return formatDate(raw);
    }
    return czech ? (valueLabels[raw] ?? raw) : raw;
  };

  const renderChange = (change: FieldChange) => (
    <li className="break-words text-sm" key={change.field}>
      <span className="font-medium">{label(change.field)}:</span>{' '}
      <span className="text-fg-secondary line-through decoration-1">{value(change.field, change.before)}</span>
      {' → '}
      <span>{value(change.field, change.after)}</span>
    </li>
  );

  const entries = load.status === 'ready' ? load.entries : [];
  const visible = showAll ? entries : entries.slice(0, 8);
  return (
    <section aria-label={t(`${k}.title`)} className="flex flex-col gap-150">
      <div>
        <h3 className="font-semibold text-fg-primary text-sm">{t(`${k}.title`)}</h3>
        <p className="text-fg-secondary text-xs">{t(`${k}.description`)}</p>
      </div>
      {load.status === 'loading' && <p className="text-fg-secondary text-sm">{t('facility-operations.common.loading')}</p>}
      {load.status === 'unavailable' && <p className="text-fg-secondary text-sm">{t(`${k}.unavailable`)}</p>}
      {load.status === 'ready' && entries.length === 0 && (
        <p className="text-fg-secondary text-sm">{t(`${k}.empty`)}</p>
      )}
      {visible.length > 0 && (
        <ol className="flex flex-col gap-150">
          {visible.map((entry, index) => (
            <li className="rounded-md border border-border-secondary p-150" key={`${DateTime.formatIso(entry.at)}-${index}`}>
              <div className="flex flex-wrap items-baseline gap-x-150 gap-y-50 text-xs">
                <span className="font-semibold text-fg-primary">{t(`${k}.${entry.kind}`)}</span>
                <span className="text-fg-secondary">
                  {formatDateTime(DateTime.formatIso(entry.at))} · {principalLabel(entry.by)}
                </span>
              </div>
              {entry.changes.length > 0 && <ul className="mt-100 flex flex-col gap-50">{entry.changes.map(renderChange)}</ul>}
            </li>
          ))}
        </ol>
      )}
      {!showAll && entries.length > visible.length && (
        <div>
          <Button onClick={() => setShowAll(true)} size="sm" theme="borderless" variant="secondary">
            {t(`${k}.more`, { count: entries.length - visible.length })}
          </Button>
        </div>
      )}
    </section>
  );
};
