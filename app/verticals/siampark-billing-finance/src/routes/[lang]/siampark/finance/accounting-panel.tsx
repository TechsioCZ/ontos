// @effect-diagnostics asyncFunction:off
// @effect-diagnostics newPromise:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
import { dialogCloseLabel, EmptyState, formatDate, formatDateTime, formatMoney, SectionCard } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Checkbox } from '@techsio/ui-kit/atoms/checkbox';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Table } from '@techsio/ui-kit/organisms/table';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { DateTime } from 'effect';
import { useState } from 'react';
import type { AccountingExport, AccountingExportFormat, Invoice } from '../../../../../shared/apis/records.ts';
import { downloadText, outcomeMessage, SimulationBadge } from './finance-ui.tsx';
import type { FinanceViewModel } from './finance-ui.tsx';
import { customerOf } from './invoice-view.ts';

const at = (value: DateTime.Utc) => formatDateTime(DateTime.formatIso(value));

const FORMATS: readonly { readonly label: string; readonly value: AccountingExportFormat }[] = [
  { label: 'CSV (středník, UTF-8)', value: 'CSV' },
  { label: 'JSON', value: 'JSON' },
  { label: 'Pohoda XML – SIMULACE', value: 'POHODA_XML_SIMULATION' },
];

const MIME: Readonly<Record<AccountingExportFormat, string>> = {
  CSV: 'text/csv;charset=utf-8',
  JSON: 'application/json',
  POHODA_XML_SIMULATION: 'application/xml',
};

const SETUP_FIELDS = [
  ['product', 'Účetní systém'],
  ['productVersion', 'Verze systému'],
  ['accountant', 'Odpovědná účetní'],
  ['transferFormat', 'Schválený přenosový formát'],
  ['approvalDate', 'Datum schválení'],
] as const;
type SetupKey = (typeof SETUP_FIELDS)[number][0];

const statusBadge = (entry: AccountingExport) =>
  entry.status === 'HANDED_OVER' ? (
    <Badge size="sm" variant="info">
      Předáno – čeká na potvrzení
    </Badge>
  ) : (
    <Badge size="sm" variant="success">
      Potvrdila účetní
    </Badge>
  );

/** S08: accounting registry (with ČEKÁ NA VSTUP), versioned handover packages and their history. */
export const AccountingPanel = ({ vm }: { readonly vm: FinanceViewModel }) => {
  const state = vm.snapshot?.state;
  const setup = state?.accountingSetup ?? {};
  const exports = [...(state?.accountingExports ?? [])].reverse();
  const confirmed = (state?.invoices ?? []).filter((invoice) => invoice.businessState === 'CONFIRMED');
  const handedOver = new Set((state?.accountingExports ?? []).flatMap((entry) => entry.invoiceResourceIds));
  const [onlyNew, setOnlyNew] = useState(true);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [format, setFormat] = useState<AccountingExportFormat>('CSV');
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Partial<Record<SetupKey, string>>>({});
  const [message, setMessage] = useState<{ readonly kind: 'error' | 'success'; readonly text: string }>();
  const [confirmTarget, setConfirmTarget] = useState<AccountingExport>();
  const [evidence, setEvidence] = useState('');
  const missing = SETUP_FIELDS.filter(([key]) => setup[key] === undefined);
  const candidates = confirmed.filter((invoice) => !onlyNew || !handedOver.has(invoice.ref.resourceId));
  const nameOf = (invoice: Invoice) =>
    customerOf(vm.references.customerById, invoice)?.displayName ?? invoice.counterpartyName ?? '—';

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });

  const saveSetup = async () => {
    const clean = (value: string | undefined) =>
      value === undefined || value.trim() === '' ? undefined : value.trim();
    const outcome = await vm.execute(
      {
        _tag: 'UpdateAccountingSetup',
        ...(vm.actorLabel === undefined ? {} : { actorLabel: vm.actorLabel }),
        ...Object.fromEntries(
          SETUP_FIELDS.flatMap(([key]) => {
            const value = clean(form[key]);
            return value === undefined ? [] : [[key, value]];
          }),
        ),
      },
      'Nastavení účetního napojení uloženo',
    );
    if (outcome.ok) {
      setEditing(false);
    } else {
      setMessage({ kind: 'error', text: outcomeMessage(vm, outcome) });
    }
  };

  const createExport = async () => {
    const ids = [...selected];
    const outcome = await vm.execute(
      {
        _tag: 'CreateAccountingExport',
        ...(vm.actorLabel === undefined ? {} : { actorLabel: vm.actorLabel }),
        counterpartyNames: Object.fromEntries(
          ids.flatMap((id) => {
            const invoice = confirmed.find((entry) => entry.ref.resourceId === id);
            const name = invoice === undefined ? undefined : nameOf(invoice);
            return name === undefined || name === '—' ? [] : [[id, name]];
          }),
        ),
        format,
        invoiceResourceIds: ids,
      },
      `Předávací balíček vytvořen (${ids.length} dokladů)`,
    );
    if (outcome.ok) {
      setSelected(new Set());
      setMessage({
        kind: 'success',
        text: `Balíček s ${ids.length} doklady je uložen v historii a připraven ke stažení.`,
      });
    } else {
      setMessage({ kind: 'error', text: outcomeMessage(vm, outcome) });
    }
  };

  const confirmExport = async () => {
    if (confirmTarget === undefined || evidence.trim() === '') {
      return;
    }
    const outcome = await vm.execute(
      {
        _tag: 'ConfirmAccountingExport',
        ...(vm.actorLabel === undefined ? {} : { actorLabel: vm.actorLabel }),
        evidence: evidence.trim(),
        exportId: confirmTarget.id,
      },
      'Převzetí balíčku potvrzeno účetní',
    );
    setConfirmTarget(undefined);
    setEvidence('');
    if (!outcome.ok) {
      setMessage({ kind: 'error', text: outcomeMessage(vm, outcome) });
    }
  };

  return (
    <div className="flex flex-col gap-250">
      <SectionCard
        actions={
          vm.canWrite && !editing ? (
            <Button
              icon="icon-[mdi--pencil-outline]"
              onClick={() => {
                setForm(Object.fromEntries(SETUP_FIELDS.map(([key]) => [key, setup[key] ?? ''])));
                setEditing(true);
              }}
              size="sm"
              theme="outlined"
              variant="secondary"
            >
              Upravit
            </Button>
          ) : undefined
        }
        title="Účetní systém a schválený formát"
      >
        {missing.length > 0 ? (
          <StatusText showIcon size="sm" status="warning">
            Přímé napojení na účetní systém je zablokované – chybí: {missing.map(([, label]) => label).join(', ')}. Do
            té doby lze účetní předávat jen exportní balíčky níže.
          </StatusText>
        ) : (
          <StatusText showIcon size="sm" status="success">
            Účetní napojení je popsané a schválené. Stav „zaúčtováno“ přesto eviduje jen účetní systém.
          </StatusText>
        )}
        {editing ? (
          <div className="grid grid-cols-1 gap-200 md:grid-cols-2">
            {SETUP_FIELDS.map(([key, label]) => (
              <FormInput
                id={`setup-${key}`}
                key={key}
                label={label}
                onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))}
                size="sm"
                type={key === 'approvalDate' ? 'date' : 'text'}
                value={form[key] ?? ''}
              />
            ))}
            <div className="flex items-end gap-100">
              <Button onClick={() => setEditing(false)} size="sm" theme="outlined" variant="secondary">
                Zrušit
              </Button>
              <Button isLoading={vm.busy} onClick={() => void saveSetup()} size="sm" variant="primary">
                Uložit
              </Button>
            </div>
          </div>
        ) : (
          <dl className="grid grid-cols-1 gap-x-400 gap-y-150 text-sm md:grid-cols-2 xl:grid-cols-3">
            {SETUP_FIELDS.map(([key, label]) => (
              <div className="flex flex-col gap-50" key={key}>
                <dt className="text-fg-secondary text-xs">{label}</dt>
                <dd>
                  {setup[key] === undefined ? (
                    <Badge size="sm" variant="warning">
                      ČEKÁ NA VSTUP
                    </Badge>
                  ) : key === 'approvalDate' ? (
                    formatDate(setup[key])
                  ) : (
                    setup[key]
                  )}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </SectionCard>

      <SectionCard
        actions={
          vm.canWrite ? (
            <>
              <div className="w-56">
                <SelectTemplate
                  aria-label="Formát"
                  items={FORMATS.map((entry) => ({
                    displayValue: entry.label,
                    label: entry.label,
                    value: entry.value,
                  }))}
                  onValueChange={({ value }) => {
                    const next = FORMATS.find((entry) => entry.value === value[0]);
                    if (next !== undefined) {
                      setFormat(next.value);
                    }
                  }}
                  size="sm"
                  value={[format]}
                />
              </div>
              <Button
                disabled={selected.size === 0 || vm.busy}
                icon="icon-[mdi--package-variant-closed]"
                onClick={() => void createExport()}
                size="sm"
                variant="primary"
              >
                Vytvořit balíček ({selected.size})
              </Button>
            </>
          ) : undefined
        }
        title="Nový předávací balíček"
      >
        <div className="flex flex-wrap items-center justify-between gap-150">
          <p className="text-fg-secondary text-sm">
            Vyberte potvrzené doklady. Balíček nese verzi schématu, identifikátory, protistranu, data, měnu, částky,
            objekt a odkaz na doklad.{' '}
            {format === 'POHODA_XML_SIMULATION' && <SimulationBadge>SIMULACE formátu Pohoda</SimulationBadge>}
          </p>
          <FormCheckbox
            checked={onlyNew}
            id="export-only-new"
            label="Jen dosud nepředané"
            onCheckedChange={setOnlyNew}
            size="sm"
          />
        </div>
        {message !== undefined && (
          <StatusText showIcon size="sm" status={message.kind}>
            {message.text}
          </StatusText>
        )}
        {candidates.length === 0 ? (
          <p className="text-fg-secondary text-sm">Žádné potvrzené doklady k předání.</p>
        ) : (
          <div className="max-h-[22rem] overflow-auto">
            <Table size="sm" variant="line">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>
                    <Checkbox
                      aria-label="Vybrat vše"
                      checked={
                        candidates.length > 0 && candidates.every((invoice) => selected.has(invoice.ref.resourceId))
                      }
                      onChange={(event) =>
                        setSelected(
                          event.target.checked
                            ? new Set(candidates.map((invoice) => invoice.ref.resourceId))
                            : new Set(),
                        )
                      }
                    />
                  </Table.ColumnHeader>
                  <Table.ColumnHeader>Doklad</Table.ColumnHeader>
                  <Table.ColumnHeader>Typ</Table.ColumnHeader>
                  <Table.ColumnHeader>Protistrana</Table.ColumnHeader>
                  <Table.ColumnHeader>Vystaveno</Table.ColumnHeader>
                  <Table.ColumnHeader align="end">Celkem</Table.ColumnHeader>
                  <Table.ColumnHeader>Předání</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {candidates.map((invoice) => (
                  <Table.Row key={invoice.ref.resourceId}>
                    <Table.Cell>
                      <Checkbox
                        aria-label={`Vybrat ${invoice.number ?? invoice.documentNumber}`}
                        checked={selected.has(invoice.ref.resourceId)}
                        onChange={() => toggle(invoice.ref.resourceId)}
                      />
                    </Table.Cell>
                    <Table.Cell className="font-medium">{invoice.number ?? invoice.documentNumber}</Table.Cell>
                    <Table.Cell>{invoice.direction === 'OUTGOING' ? 'Vydaná' : 'Přijatá'}</Table.Cell>
                    <Table.Cell>{nameOf(invoice)}</Table.Cell>
                    <Table.Cell>{formatDate(invoice.issueDate)}</Table.Cell>
                    <Table.Cell align="end" className="tabular-nums">
                      {formatMoney(invoice.totalMinor)}
                    </Table.Cell>
                    <Table.Cell>
                      {handedOver.has(invoice.ref.resourceId) ? (
                        <Badge size="sm" variant="info">
                          Už předáno
                        </Badge>
                      ) : (
                        <span className="text-fg-secondary text-xs">Nepředáno</span>
                      )}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
        )}
      </SectionCard>

      <SectionCard flush title="Historie předání">
        {exports.length === 0 ? (
          <div className="px-250 pb-250">
            <EmptyState
              description="Vytvořené balíčky se zde objeví s autorem, časem a otiskem souboru."
              title="Zatím nic nepředáno"
            />
          </div>
        ) : (
          <Table size="sm" variant="line">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>Balíček</Table.ColumnHeader>
                <Table.ColumnHeader>Formát</Table.ColumnHeader>
                <Table.ColumnHeader align="end">Doklady</Table.ColumnHeader>
                <Table.ColumnHeader>Vytvořil / kdy</Table.ColumnHeader>
                <Table.ColumnHeader>Otisk SHA-256</Table.ColumnHeader>
                <Table.ColumnHeader>Stav</Table.ColumnHeader>
                <Table.ColumnHeader align="end">Akce</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {exports.map((entry) => (
                <Table.Row key={entry.id}>
                  <Table.Cell>
                    <span className="flex flex-col">
                      <span className="font-medium">{entry.batchNumber}</span>
                      <span className="text-fg-secondary text-xs">
                        verze {entry.version} · schéma {entry.schemaVersion}
                      </span>
                    </span>
                  </Table.Cell>
                  <Table.Cell>
                    {entry.format === 'POHODA_XML_SIMULATION' ? (
                      <SimulationBadge>Pohoda XML – SIMULACE</SimulationBadge>
                    ) : (
                      entry.format
                    )}
                  </Table.Cell>
                  <Table.Cell align="end" className="tabular-nums">
                    <details>
                      <summary className="cursor-pointer whitespace-nowrap text-sm">
                        Doklady ({entry.invoiceResourceIds.length})
                      </summary>
                      <ul className="flex flex-col gap-50 py-100 text-xs">
                        {entry.invoiceResourceIds.map((id) => {
                          const invoice = state?.invoices.find((item) => item.ref.resourceId === id);
                          return (
                            <li key={id}>
                              <a className="whitespace-nowrap underline" href={`?resourceId=${encodeURIComponent(id)}`}>
                                {invoice?.number ?? invoice?.documentNumber ?? 'Doklad není dostupný'}
                              </a>
                            </li>
                          );
                        })}
                      </ul>
                    </details>
                  </Table.Cell>
                  <Table.Cell>
                    <span className="flex flex-col">
                      <span>{entry.actorLabel ?? 'neznámý uživatel'}</span>
                      <span className="text-fg-secondary text-xs">{at(entry.createdAt)}</span>
                    </span>
                  </Table.Cell>
                  <Table.Cell>
                    <code className="text-xs">{entry.sha256.slice(0, 16)}…</code>
                  </Table.Cell>
                  <Table.Cell>
                    <span className="flex flex-col gap-50">
                      {statusBadge(entry)}
                      {entry.confirmedAt !== undefined && (
                        <span className="text-fg-secondary text-xs">
                          {entry.confirmedByLabel ?? ''} · {at(entry.confirmedAt)}
                          {entry.confirmationEvidence === undefined ? '' : ` · ${entry.confirmationEvidence}`}
                        </span>
                      )}
                    </span>
                  </Table.Cell>
                  <Table.Cell align="end">
                    <span className="flex justify-end gap-50">
                      <Button
                        className="whitespace-nowrap"
                        icon="icon-[mdi--download]"
                        onClick={() => downloadText(entry.content, MIME[entry.format], entry.fileName)}
                        size="sm"
                        theme="borderless"
                        variant="secondary"
                      >
                        Stáhnout
                      </Button>
                      {vm.canWrite && entry.status === 'HANDED_OVER' && (
                        <Button
                          className="whitespace-nowrap"
                          onClick={() => setConfirmTarget(entry)}
                          size="sm"
                          theme="outlined"
                          variant="secondary"
                        >
                          Potvrzení účetní
                        </Button>
                      )}
                    </span>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        )}
      </SectionCard>
      <Dialog
        actions={
          <>
            <Button onClick={() => setConfirmTarget(undefined)} theme="outlined" variant="secondary">
              Zrušit
            </Button>
            <Button disabled={evidence.trim() === '' || vm.busy} onClick={() => void confirmExport()} variant="primary">
              Uložit potvrzení
            </Button>
          </>
        }
        closeLabel={dialogCloseLabel}
        customTrigger
        description="Zaznamenejte, že účetní balíček převzala, a uveďte důkaz (např. e-mail ze dne…, číslo importní dávky). OntOS tím doklady neoznačí jako zaúčtované."
        onOpenChange={(details) => {
          if (!details.open) {
            setConfirmTarget(undefined);
          }
        }}
        open={confirmTarget !== undefined}
        placement="center"
        size="sm"
        title={`Potvrzení převzetí ${confirmTarget?.batchNumber ?? ''}`}
      >
        <FormInput
          id="export-evidence"
          label="Důkaz převzetí"
          onChange={(event) => setEvidence(event.target.value)}
          placeholder="např. e-mail Ing. Novákové z 20. 10. 2026"
          size="sm"
          value={evidence}
        />
      </Dialog>
    </div>
  );
};
