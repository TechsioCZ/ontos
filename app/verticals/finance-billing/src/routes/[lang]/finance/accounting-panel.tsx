import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { financeBrowserAtomRuntime, financeBrowserRuntime } from '../../../runtime/browser.ts';
import { FinanceTableScroll } from './finance-table-scroll.tsx';
import { EmptyState, formatDate, formatDateTime, formatMoney, SectionCard } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Accordion } from '@techsio/ui-kit/molecules/accordion';
import { Link } from '@techsio/ui-kit/atoms/link';
import { Button } from '@techsio/ui-kit/atoms/button';
import {
  CheckboxField,
  FormBuilder,
  FormReact,
  FormRoot,
  RowCheckboxField,
  SelectTemplateField,
  useAtomSet,
} from '@app/core-runtime/ui/form';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Table } from '@techsio/ui-kit/organisms/table';
import { DateTime, Effect, Schema } from 'effect';
import type { ReactNode } from 'react';
import { useRef, useState } from 'react';
import { useFormDraft } from './finance-form-draft.tsx';
import type { AccountingExport, AccountingExportFormat, Invoice } from '../../../../shared/apis/records.ts';
import { downloadText, outcomeNotice } from './finance-ui.tsx';
import type { FinanceCommandDraft, FinanceViewModel } from './finance-ui.tsx';
import { customerOf } from './invoice-view.ts';
import { useInvoiceIssuer } from './use-invoice-issuer.ts';
import { EXPORT_STATUS } from './invoice-extras.tsx';
import { AccountingSetupForm, ISSUER_FIELDS, SETUP_FIELDS } from './accounting-setup-form.tsx';
import { ExportConfirmationForm, ExportFailureForm } from './accounting-decision-forms.tsx';
import type { SetupKey } from './accounting-setup-form.tsx';

const at = (value: DateTime.Utc) => formatDateTime(DateTime.formatIso(value));

/**
 * What the next package takes: the file format, whether only invoices not yet handed over are listed, and the selected
 * rows. A command, not a form: "Vytvořit balíček" builds the package from these; no record is edited.
 */
const exportSelectionForm = FormReact.make(
  FormBuilder.empty
    .addField('format', Schema.String)
    .addField('onlyNew', Schema.Boolean)
    .addField('selected', Schema.Array(Schema.String)),
  {
    fields: {
      format: SelectTemplateField,
      onlyNew: CheckboxField,
      selected: RowCheckboxField,
    },
    onSubmit: () => Effect.void,
    runtime: financeBrowserAtomRuntime,
  },
);

const openedSelection = {
  format: 'CSV',
  onlyNew: true,
  selected: [],
} as const satisfies typeof exportSelectionForm.schema.Encoded;
const selectedRows = exportSelectionForm.getFieldAtoms(exportSelectionForm.fields.selected);

/** The selection's form around the package section; `ready` marks that this mount initialized it. */
const SelectionForm = ({ children, ready }: { readonly children: ReactNode; readonly ready: ReactNode }) => {
  const { t } = useModernI18n();
  return (
    <FormRoot defaultValues={openedSelection} form={exportSelectionForm} translateMessage={t}>
      {ready}
      {children}
    </FormRoot>
  );
};

const FORMATS: readonly { readonly label: string; readonly value: AccountingExportFormat }[] = [
  { label: 'CSV (středník, UTF-8)', value: 'CSV' },
  { label: 'JSON', value: 'JSON' },
  { label: 'POHODA XML (dataPack 2.0)', value: 'POHODA_XML' },
];

const MIME = {
  CSV: 'text/csv;charset=utf-8',
  JSON: 'application/json',
  POHODA_XML: 'application/xml',
} satisfies Readonly<Record<AccountingExportFormat, string>>;

const FORMAT_LABEL = {
  CSV: 'CSV',
  JSON: 'JSON',
  POHODA_XML: 'POHODA XML',
} satisfies Readonly<Record<AccountingExportFormat, string>>;

const statusBadge = (entry: AccountingExport) => (
  <Badge className="whitespace-nowrap" severity={EXPORT_STATUS[entry.status].variant} size="sm">
    {EXPORT_STATUS[entry.status].label}
  </Badge>
);

/** Readable author label (display hint) next to the authenticated principal the server stored. */
const authorText = (entry: AccountingExport) => entry.actorLabel ?? 'neznámý uživatel';

const AccountingSetupValue = ({ field, value }: { readonly field: SetupKey; readonly value: string | undefined }) => {
  if (value === undefined) {
    return (
      <Badge severity="warning" size="sm">
        ČEKÁ NA VSTUP
      </Badge>
    );
  }
  return field === 'approvalDate' ? formatDate(value) : value;
};

/** S08: accounting registry (with ČEKÁ NA VSTUP), versioned handover packages and their history. */
/** The panel's status line: a confirmed step, a refusal, or a proposal still waiting for approval (neutral). */
interface PanelMessage {
  readonly kind: 'default' | 'error' | 'success';
  readonly text: string;
}

const panelMessage = (
  vm: FinanceViewModel,
  outcome: { readonly feedback: string; readonly ok: false; readonly reason?: string },
): PanelMessage => {
  const notice = outcomeNotice(vm, outcome);
  return { kind: notice.status, text: notice.text };
};

const accountingPanelCreateExportProgram = Effect.fn('Finance.createExport')(
  function* accountingPanelCreateExportProgram(
    context: Pick<
      ReturnType<typeof useAccountingPanel>,
      'creating' | 'format' | 'selected' | 'setMessage' | 'setSelected' | 'vm'
    >,
  ) {
    const { creating, format, selected, setMessage, setSelected, vm } = context;
    if (creating.current) {
      return;
    }
    creating.current = true;
    const ids = [...selected];
    // Issuer name and partner IČO/DIČ are resolved by the server from Core and the party registry.
    const createAccountingExportCommand: FinanceCommandDraft<'CreateAccountingExport'> = {
      _tag: 'CreateAccountingExport',
      format,
      invoiceResourceIds: ids,
    };
    if (vm.actorLabel !== undefined) {
      createAccountingExportCommand.actorLabel = vm.actorLabel;
    }
    const outcome = yield* vm
      .execute(createAccountingExportCommand, `Předávací balíček vytvořen (${ids.length} dokladů)`)
      .pipe(
        Effect.ensuring(
          Effect.sync(() => {
            creating.current = false;
          }),
        ),
      );
    if (outcome.ok) {
      setSelected(new Set());
      setMessage({
        kind: 'success',
        text: `Balíček je připravený (stav „Připraveno k předání“). Stáhněte soubor, pošlete ho účetní a v historii klikněte na Předat účetní.`,
      });
    } else {
      setMessage(
        outcome.feedback === 'unavailable'
          ? {
              kind: 'error',
              text: 'Balíček nevznikl: vystavitele nebo údaje partnerů z adresáře se teď nepodařilo ověřit. Nic se neuložilo, zkuste to prosím znovu.',
            }
          : panelMessage(vm, outcome),
      );
    }
  },
);

const accountingPanelHandOverProgram = Effect.fn('Finance.handOver')(function* accountingPanelHandOverProgram(
  context: Pick<ReturnType<typeof useAccountingPanel>, 'setMessage' | 'vm'>,
  entry: AccountingExport,
) {
  const { setMessage, vm } = context;
  const handOverAccountingExportCommand: FinanceCommandDraft<'HandOverAccountingExport'> = {
    _tag: 'HandOverAccountingExport',
    exportId: entry.id,
  };
  if (vm.actorLabel !== undefined) {
    handOverAccountingExportCommand.actorLabel = vm.actorLabel;
  }
  const outcome = yield* vm.execute(handOverAccountingExportCommand, `Balíček ${entry.batchNumber} předán účetní`);
  if (!outcome.ok) {
    setMessage(panelMessage(vm, outcome));
  }
});

const useAccountingPanel = (vm: FinanceViewModel) => {
  const state = vm.snapshot?.state;
  const setup = state?.accountingSetup ?? {};
  const exports = (state?.accountingExports ?? []).toReversed();
  const confirmed = (state?.invoices ?? []).filter((invoice) => invoice.businessState === 'CONFIRMED');
  // A failed package hands nothing over: its invoices go into the next package again.
  const handedOver = new Set<string>(
    (state?.accountingExports ?? []).flatMap((entry) => (entry.status === 'FAILED' ? [] : entry.invoiceResourceIds)),
  );
  const [failTarget, setFailTarget] = useState<AccountingExport>();
  const selection = useFormDraft(exportSelectionForm, openedSelection);
  const { onlyNew } = selection.draft;
  const selected: ReadonlySet<string> = new Set(selection.draft.selected);
  const format: AccountingExportFormat =
    FORMATS.find((entry) => entry.value === selection.draft.format)?.value ?? 'CSV';
  const setSelectedRows = useAtomSet(selectedRows.setValue);
  const setSelected = (next: ReadonlySet<string>) => setSelectedRows([...next]);
  const [editing, setEditing] = useState(false);
  const issuerName = useInvoiceIssuer();
  const [message, setMessage] = useState<PanelMessage>();
  const [confirmTarget, setConfirmTarget] = useState<AccountingExport>();
  // Blocks a second click in the same render tick, before vm.busy reaches this component.
  const creating = useRef(false);
  const missing = SETUP_FIELDS.filter(([key]) => setup[key] === undefined);
  const candidates = confirmed.filter((invoice) => !onlyNew || !handedOver.has(invoice.ref.resourceId));
  const withoutVatBreakdown = confirmed.filter(
    (invoice) => selected.has(invoice.ref.resourceId) && invoice.vatRecap === undefined && invoice.lines === undefined,
  ).length;
  const nameOf = (invoice: Invoice) =>
    customerOf(vm.references.customerById, invoice)?.displayName ?? invoice.counterpartyName ?? '—';

  const createExport = (): void => {
    void financeBrowserRuntime.runPromise(
      accountingPanelCreateExportProgram({ creating, format, selected, setMessage, setSelected, vm }),
    );
  };

  const handOver = (entry: AccountingExport): void => {
    void financeBrowserRuntime.runPromise(accountingPanelHandOverProgram({ setMessage, vm }, entry));
  };

  return {
    candidates,
    confirmed,
    confirmTarget,
    createExport,
    creating,
    editing,
    exports,
    failTarget,
    format,
    handedOver,
    handOver,
    issuerName,
    message,
    missing,
    nameOf,
    selected,
    selectionReady: selection.ready,
    setConfirmTarget,
    setEditing,
    setFailTarget,
    setMessage,
    setSelected,
    setup,
    state,
    vm,
    withoutVatBreakdown,
  };
};

const AccountingSetup = (model: ReturnType<typeof useAccountingPanel>) => {
  const { t } = useModernI18n();
  const { editing, issuerName, missing, setEditing, setup, vm } = model;
  return (
    <SectionCard
      actions={
        vm.canWrite && !editing ? (
          <Button
            appearance="outline"
            icon="icon-[mdi--pencil-outline]"
            onClick={() => setEditing(true)}
            severity="secondary"
            size="sm"
          >
            Upravit
          </Button>
        ) : undefined
      }
      title={t('finance-billing.financeUi.accounting.setup')}
    >
      {missing.length > 0 ? (
        <StatusText showIcon size="sm" status="warning">
          Přímé napojení na účetní systém je zablokované – chybí: {missing.map(([, label]) => label).join(', ')}. Do té
          doby lze účetní předávat jen exportní balíčky níže.
        </StatusText>
      ) : (
        <StatusText showIcon size="sm" status="success">
          Účetní napojení je popsané a schválené. Stav „zaúčtováno“ přesto eviduje jen účetní systém.
        </StatusText>
      )}
      {editing ? (
        <AccountingSetupForm onClose={() => setEditing(false)} vm={vm} />
      ) : (
        <>
          <dl className="grid grid-cols-1 gap-x-400 gap-y-150 text-sm md:grid-cols-2 xl:grid-cols-3">
            {SETUP_FIELDS.map(([key, label]) => (
              <div className="flex flex-col gap-50" key={key}>
                <dt className="text-fg-secondary text-xs">{label}</dt>
                <dd>
                  <AccountingSetupValue field={key} value={setup[key]} />
                </dd>
              </div>
            ))}
          </dl>
          <div className="flex flex-col gap-100 pt-150">
            <h3 className="font-medium text-sm">Účetní jednotka (vystavitel dokladů)</h3>
            <dl className="grid grid-cols-1 gap-x-400 gap-y-150 text-sm md:grid-cols-2 xl:grid-cols-3">
              <div className="flex flex-col gap-50">
                <dt className="text-fg-secondary text-xs">Název (vybraná firma)</dt>
                <dd>{issuerName ?? 'Ověří se z vybrané firmy při vytvoření balíčku'}</dd>
              </div>
              {ISSUER_FIELDS.map(([key, label]) => (
                <div className="flex flex-col gap-50" key={key}>
                  <dt className="text-fg-secondary text-xs">{label}</dt>
                  <dd>
                    {setup[key] ?? (
                      <Badge severity="warning" size="sm">
                        ČEKÁ NA VSTUP
                      </Badge>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </>
      )}
    </SectionCard>
  );
};

const AccountingSelection = (model: ReturnType<typeof useAccountingPanel>) => {
  const { t } = useModernI18n();
  const {
    candidates,
    createExport,
    format,
    handedOver,
    message,
    nameOf,
    selected,
    selectionReady,
    setup,
    vm,
    withoutVatBreakdown,
  } = model;
  return (
    <SelectionForm ready={selectionReady}>
      <SectionCard
        actions={
          vm.canWrite ? (
            <>
              <div className="w-64">
                <exportSelectionForm.format
                  aria-label={t('finance-billing.financeUi.accounting.format')}
                  items={FORMATS.map((entry) => ({ label: entry.label, value: entry.value }))}
                  size="sm"
                />
              </div>
              {/* A command, not a form: the export builds a package from the selected rows; no record is edited. */}
              <Button
                disabled={selected.size === 0 || vm.busy}
                icon="icon-[mdi--package-variant-closed]"
                onClick={() => {
                  createExport();
                }}
                severity="primary"
                size="sm"
              >
                Vytvořit balíček ({selected.size})
              </Button>
            </>
          ) : undefined
        }
        title={t('finance-billing.financeUi.accounting.newPackage')}
      >
        <div className="flex flex-wrap items-center justify-between gap-150">
          <p className="text-fg-secondary text-sm">
            Vyberte potvrzené doklady. Balíček nese verzi schématu, identifikátory, protistranu, data, měnu, částky,
            objekt a odkaz na doklad.
          </p>
          <exportSelectionForm.onlyNew id="export-only-new" label={t('finance-billing.financeUi.accounting.onlyNew')} />
        </div>
        {format === 'POHODA_XML' && (
          <div className="flex flex-col gap-100">
            <StatusText showIcon size="sm" status="default">
              Soubor odpovídá oficiálnímu schématu STORMWARE POHODA XML (dataPack 2.0, vydané i přijaté faktury). Import
              do POHODA a zaúčtování provádí účetní.
            </StatusText>
            <StatusText showIcon size="sm" status="default">
              DUZP se vyplní datem vystavení a forma úhrady „příkazem“ – OntOS je u dokladu samostatně neeviduje.
            </StatusText>
            {setup.issuerIco === undefined && (
              <StatusText showIcon size="sm" status="warning">
                IČO účetní jednotky není vyplněné – soubor ho neponese a POHODA ho naimportuje do právě otevřené účetní
                jednotky. Doplňte IČO v sekci Účetní jednotka výše.
              </StatusText>
            )}
            {withoutVatBreakdown > 0 && (
              <StatusText showIcon size="sm" status="warning">
                Vybrané doklady bez rozpisu DPH: {withoutVatBreakdown}. V POHODA budou označené „Nezahrnovat do DPH“ s
                poznámkou, aby účetní doplnila členění podle originálu dokladu.
              </StatusText>
            )}
          </div>
        )}
        {message !== undefined && (
          <StatusText showIcon size="sm" status={message.kind}>
            {message.text}
          </StatusText>
        )}
        {candidates.length === 0 ? (
          <p className="text-fg-secondary text-sm">Žádné potvrzené doklady k předání.</p>
        ) : (
          <div className="max-h-[22rem] overflow-auto">
            <Table appearance="line" size="sm">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>
                    <exportSelectionForm.selected
                      aria-label={t('finance-billing.financeUi.common.selectAll')}
                      members={candidates.map((invoice) => invoice.ref.resourceId)}
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
                      <exportSelectionForm.selected
                        aria-label={`Vybrat ${invoice.number ?? invoice.documentNumber}`}
                        member={invoice.ref.resourceId}
                      />
                    </Table.Cell>
                    <Table.Cell className="whitespace-nowrap font-medium">
                      {invoice.number ?? invoice.documentNumber}
                    </Table.Cell>
                    <Table.Cell>{invoice.direction === 'OUTGOING' ? 'Vydaná' : 'Přijatá'}</Table.Cell>
                    <Table.Cell>{nameOf(invoice)}</Table.Cell>
                    <Table.Cell>{formatDate(invoice.issueDate)}</Table.Cell>
                    <Table.Cell align="end" className="tabular-nums">
                      {formatMoney(invoice.totalMinor)}
                    </Table.Cell>
                    <Table.Cell>
                      {handedOver.has(invoice.ref.resourceId) ? (
                        <Badge severity="info" size="sm">
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
    </SelectionForm>
  );
};

const AccountingHistoryStatus = ({ entry }: { readonly entry: AccountingExport }) => (
  <Table.Cell>
    <span className="flex flex-col gap-50">
      {statusBadge(entry)}
      {entry.handedOverAt !== undefined && (
        <span className="text-fg-secondary text-xs">
          předáno {entry.handedOverByLabel ?? ''} · {at(entry.handedOverAt)}
        </span>
      )}
      {entry.status === 'FAILED' && (
        <span className="max-w-56 break-words text-danger text-xs">
          {entry.failureReason ?? 'Chyba'}
          {entry.failedAt === undefined ? '' : ` · ${entry.failedByLabel ?? ''} ${at(entry.failedAt)}`}
        </span>
      )}
      {entry.confirmedAt !== undefined && (
        <span className="text-fg-secondary text-xs">
          {entry.confirmedByLabel ?? ''} · {at(entry.confirmedAt)}
          {entry.confirmationEvidence === undefined ? '' : ` · ${entry.confirmationEvidence}`}
        </span>
      )}
    </span>
  </Table.Cell>
);

const AccountingHistory = (model: ReturnType<typeof useAccountingPanel>) => {
  const { t } = useModernI18n();
  const { exports, handOver, setConfirmTarget, setFailTarget, state, vm } = model;
  return (
    <SectionCard flush title={t('finance-billing.financeUi.accounting.history')}>
      {exports.length === 0 ? (
        <div className="px-250 pb-250">
          <EmptyState
            description="Vytvořené balíčky se zde objeví s autorem, časem a otiskem souboru."
            title={t('finance-billing.financeUi.accounting.empty')}
          />
        </div>
      ) : (
        <FinanceTableScroll label={t('finance-billing.financeUi.accounting.historyTable')}>
          <Table appearance="line" size="sm">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader className="whitespace-nowrap">Balíček</Table.ColumnHeader>
                <Table.ColumnHeader className="whitespace-nowrap">Formát</Table.ColumnHeader>
                <Table.ColumnHeader align="end" className="whitespace-nowrap">
                  Doklady
                </Table.ColumnHeader>
                <Table.ColumnHeader className="whitespace-nowrap">Vytvořil / kdy</Table.ColumnHeader>
                <Table.ColumnHeader className="whitespace-nowrap">Otisk SHA-256</Table.ColumnHeader>
                <Table.ColumnHeader className="whitespace-nowrap">Stav</Table.ColumnHeader>
                <Table.ColumnHeader align="end" className="whitespace-nowrap">
                  Akce
                </Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {exports.map((entry) => (
                <Table.Row key={entry.id}>
                  <Table.Cell>
                    <span className="flex flex-col">
                      <span className="whitespace-nowrap font-medium">{entry.batchNumber}</span>
                      <span className="text-fg-secondary text-xs">
                        verze {entry.version} ·{' '}
                        {entry.format === 'POHODA_XML' ? 'STORMWARE dataPack 2.0' : `schéma ${entry.schemaVersion}`}
                      </span>
                      {entry.issuerName !== undefined && (
                        <span className="text-fg-secondary text-xs">
                          Vystavitel: {entry.issuerName}
                          {entry.issuerIco === undefined ? ' · IČO nevyplněno' : ` · IČO ${entry.issuerIco}`}
                        </span>
                      )}
                      {entry.content !== '' &&
                        !['/cs/finance?resourceId=', '/cs/siampark/finance?resourceId='].some((link) =>
                          entry.content.includes(link),
                        ) && (
                          <span className="text-fg-secondary text-xs">
                            Historická verze bez webových odkazů. Použijte novější balíček; původní soubor i otisk
                            zůstávají zachovány.
                          </span>
                        )}
                    </span>
                  </Table.Cell>
                  <Table.Cell>{FORMAT_LABEL[entry.format]}</Table.Cell>
                  <Table.Cell align="end" className="tabular-nums">
                    <Accordion appearance="ghost" collapsible size="sm">
                      <Accordion.Item value={entry.id}>
                        <Accordion.Header>
                          <Accordion.Title className="whitespace-nowrap text-sm">
                            Doklady ({entry.invoiceResourceIds.length})
                          </Accordion.Title>
                          <Accordion.Indicator />
                        </Accordion.Header>
                        <Accordion.Content>
                          <ul className="flex flex-col gap-50 py-100 text-xs">
                            {entry.invoiceResourceIds.map((id) => {
                              const invoice = state?.invoices.find((item) => item.ref.resourceId === id);
                              return (
                                <li key={id}>
                                  <Link
                                    className="whitespace-nowrap"
                                    href={`?resourceId=${encodeURIComponent(id)}`}
                                    size="current"
                                  >
                                    {invoice?.number ?? invoice?.documentNumber ?? 'Doklad není dostupný'}
                                  </Link>
                                </li>
                              );
                            })}
                          </ul>
                        </Accordion.Content>
                      </Accordion.Item>
                    </Accordion>
                  </Table.Cell>
                  <Table.Cell>
                    <span className="flex flex-col">
                      <span>{authorText(entry)}</span>
                      {entry.actorPrincipalId !== undefined && (
                        <span className="text-fg-secondary text-xs">
                          ověřený účet {entry.actorPrincipalId.slice(0, 8)}…
                        </span>
                      )}
                      <span className="text-fg-secondary text-xs">{at(entry.createdAt)}</span>
                    </span>
                  </Table.Cell>
                  <Table.Cell>
                    <code className="text-xs">{entry.sha256.slice(0, 16)}…</code>
                  </Table.Cell>
                  <AccountingHistoryStatus entry={entry} />
                  <Table.Cell align="end">
                    <span className="flex justify-end gap-50">
                      {entry.content === '' ? (
                        <span className="text-fg-secondary text-xs">Soubor jen pro finance a účetní</span>
                      ) : (
                        <Button
                          appearance="ghost"
                          className="whitespace-nowrap"
                          icon="icon-[mdi--download]"
                          onClick={() => downloadText(entry.content, MIME[entry.format], entry.fileName)}
                          severity="secondary"
                          size="sm"
                        >
                          Stáhnout
                        </Button>
                      )}
                      {vm.canWrite && entry.status === 'PREPARED' && (
                        <Button
                          appearance="outline"
                          className="whitespace-nowrap"
                          disabled={vm.busy}
                          icon="icon-[mdi--send-check-outline]"
                          onClick={() => {
                            handOver(entry);
                          }}
                          severity="secondary"
                          size="sm"
                        >
                          Předat účetní
                        </Button>
                      )}
                      {vm.canWrite && entry.status === 'HANDED_OVER' && (
                        <Button
                          appearance="outline"
                          className="whitespace-nowrap"
                          onClick={() => setConfirmTarget(entry)}
                          severity="secondary"
                          size="sm"
                        >
                          Potvrzení účetní
                        </Button>
                      )}
                      {vm.canWrite && (entry.status === 'PREPARED' || entry.status === 'HANDED_OVER') && (
                        <Button
                          appearance="ghost"
                          className="whitespace-nowrap"
                          onClick={() => setFailTarget(entry)}
                          severity="secondary"
                          size="sm"
                        >
                          Označit chybu
                        </Button>
                      )}
                    </span>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </FinanceTableScroll>
      )}
    </SectionCard>
  );
};

export const AccountingPanel = ({ vm }: { readonly vm: FinanceViewModel }) => {
  const model = useAccountingPanel(vm);
  return (
    <div className="flex flex-col gap-250">
      <AccountingSetup {...model} />

      <AccountingSelection {...model} />

      <AccountingHistory {...model} />
      {model.failTarget !== undefined && (
        <ExportFailureForm entry={model.failTarget} onClose={() => model.setFailTarget(undefined)} vm={vm} />
      )}
      {model.confirmTarget !== undefined && (
        <ExportConfirmationForm entry={model.confirmTarget} onClose={() => model.setConfirmTarget(undefined)} vm={vm} />
      )}
    </div>
  );
};
