import { VAT_RATE_CHOICES } from '../../../../shared/domain/invoice-draft.ts';
import { financeBrowserRuntime } from '../../../runtime/browser.ts';
import { Effect } from 'effect';
import { FinanceTableScroll } from './finance-table-scroll.tsx';
import { formatCzechDays } from '@app/shared-contracts';
import { dialogCloseLabel, EmptyState, formatDate, formatMoney, SectionCard, SidePanel } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Checkbox } from '@techsio/ui-kit/atoms/checkbox';
import { invoiceLifecycle, LIFECYCLE_PRESENTATION } from './invoice-view.ts';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Table } from '@techsio/ui-kit/organisms/table';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { useState } from 'react';
import type { RecurringTemplate, VatRate } from '../../../../shared/apis/records.ts';
import { addMonths, monthOf } from '../../../../shared/domain/finance-planning.ts';
import { computeInvoiceTotals } from '../../../../shared/domain/invoice-totals.ts';
import { monthLabel, outcomeMessage, parseAmountMinor } from './finance-ui.tsx';
import type { FinanceCommandDraft, FinanceViewModel } from './finance-ui.tsx';

const templateTotal = (template: RecurringTemplate) => computeInvoiceTotals(template.lines)?.totalMinor ?? 0;

interface TemplateDraft {
  readonly amount: string;
  readonly customerId: string;
  readonly description: string;
  readonly dueDays: string;
  readonly issueDay: string;
  readonly name: string;
  readonly vatRate: VatRate;
}

const emptyTemplate: TemplateDraft = {
  amount: '',
  customerId: '',
  description: 'Nájemné za prostor',
  dueDays: '14',
  issueDay: '1',
  name: '',
  vatRate: 21,
};

interface GenerationResult {
  readonly created: readonly string[];
  readonly duplicates: readonly RecurringTemplate[];
  readonly failed: readonly string[];
}

/** S07.R3 / S07-05: rent templates, per-period generation with duplicate protection. */
const recurringPanelGenerateProgram = Effect.fn('Finance.generate')(function* recurringPanelGenerateProgram(
  context: Pick<
    ReturnType<typeof useRecurringPanel>,
    'period' | 'setDuplicateTarget' | 'setResult' | 'setRunning' | 'vm'
  >,
  targets: readonly RecurringTemplate[],
) {
  const { period, setDuplicateTarget, setResult, setRunning, vm } = context;
  setRunning(true);
  const created: string[] = [];
  const duplicates: RecurringTemplate[] = [];
  const failed: string[] = [];
  yield* Effect.forEach(
    targets,
    (template) =>
      vm
        .execute({
          _tag: 'GenerateRecurringInvoice',
          confirmDuplicate: false,
          period,
          templateId: template.id,
        })
        .pipe(
          Effect.tap((outcome) =>
            Effect.sync(() => {
              if (outcome.ok) {
                created.push(outcome.invoice?.number ?? template.name);
              } else if (outcome.reason?.includes('recurring_period_already_generated') === true) {
                duplicates.push(template);
              } else {
                failed.push(`${template.name}: ${outcomeMessage(vm, outcome)}`);
              }
            }),
          ),
        ),
    { concurrency: 1, discard: true },
  );
  setRunning(false);
  setResult({ created, duplicates, failed });
  if (targets.length === 1 && duplicates.length === 1) {
    setDuplicateTarget(duplicates[0]);
  }
});

const recurringPanelGenerateDuplicateProgram = Effect.fn('Finance.generateDuplicate')(
  function* recurringPanelGenerateDuplicateProgram(
    context: Pick<
      ReturnType<typeof useRecurringPanel>,
      'duplicateTarget' | 'period' | 'setDuplicateTarget' | 'setResult' | 'vm'
    >,
  ) {
    const { duplicateTarget, period, setDuplicateTarget, setResult, vm } = context;
    if (duplicateTarget === undefined) {
      return;
    }
    const outcome = yield* vm.execute(
      { _tag: 'GenerateRecurringInvoice', confirmDuplicate: true, period, templateId: duplicateTarget.id },
      'Druhý návrh vytvořen na výslovné potvrzení',
    );
    setDuplicateTarget(undefined);
    if (outcome.ok) {
      setResult({ created: [outcome.invoice?.number ?? duplicateTarget.name], duplicates: [], failed: [] });
    }
  },
);

const recurringPanelCreateTemplateProgram = Effect.fn('Finance.createTemplate')(
  function* recurringPanelCreateTemplateProgram(
    context: Pick<
      ReturnType<typeof useRecurringPanel>,
      'customers' | 'draft' | 'setCreating' | 'setDraft' | 'setFormError' | 'vm'
    >,
  ) {
    const { customers, draft, setCreating, setDraft, setFormError, vm } = context;
    const customer = customers.find((entry) => entry.partyId === draft.customerId);
    const amountMinor = parseAmountMinor(draft.amount);
    const issueDay = Number(draft.issueDay);
    const dueDays = Number(draft.dueDays);
    if (customer === undefined || draft.name.trim() === '' || draft.description.trim() === '') {
      setFormError('Vyberte nájemce a vyplňte název a popis položky.');
      return;
    }
    if (amountMinor === undefined || amountMinor === 0) {
      setFormError('Zadejte měsíční částku bez DPH.');
      return;
    }
    if (
      !Number.isInteger(issueDay) ||
      issueDay < 1 ||
      issueDay > 28 ||
      !Number.isInteger(dueDays) ||
      dueDays < 1 ||
      dueDays > 90
    ) {
      setFormError('Den vystavení musí být 1–28 a splatnost 1–90 dní.');
      return;
    }
    const createRecurringTemplateCommand: FinanceCommandDraft<'CreateRecurringTemplate'> = {
      _tag: 'CreateRecurringTemplate',
      counterpartyRef: customer.counterpartyRef,
      dueDays,
      issueDay,
      lines: [
        { description: draft.description.trim(), quantity: 1, unitPriceMinor: amountMinor, vatRate: draft.vatRate },
      ],
      name: draft.name.trim(),
      partyId: customer.partyId,
    };
    if (customer.displayName !== null) {
      createRecurringTemplateCommand.counterpartyName = customer.displayName;
    }
    const outcome = yield* vm.execute(createRecurringTemplateCommand, 'Šablona opakované faktury uložena');
    if (outcome.ok) {
      setCreating(false);
      setDraft(emptyTemplate);
      setFormError(undefined);
    } else {
      setFormError(outcomeMessage(vm, outcome));
    }
  },
);

const recurringPanelPrepareSelectedProgram = Effect.fn('Finance.prepareSelected')(
  function* recurringPanelPrepareSelectedProgram(
    context: Pick<ReturnType<typeof useRecurringPanel>, 'selectedDrafts' | 'setBulkResult' | 'setBulkSelected' | 'vm'>,
  ) {
    const { selectedDrafts, setBulkResult, setBulkSelected, vm } = context;
    if (selectedDrafts.length === 0) {
      return;
    }
    const markInvoicesPreparedCommand: FinanceCommandDraft<'MarkInvoicesPrepared'> = {
      _tag: 'MarkInvoicesPrepared',
      invoiceRefs: selectedDrafts.map((invoice) => invoice.ref),
    };
    if (vm.actorLabel !== undefined) {
      markInvoicesPreparedCommand.actorLabel = vm.actorLabel;
    }
    const outcome = yield* vm.execute(markInvoicesPreparedCommand, `Připraveno ke schválení: ${selectedDrafts.length}`);
    if (outcome.ok) {
      setBulkResult({
        kind: 'success',
        text: `${selectedDrafts.map((invoice) => invoice.number ?? invoice.documentNumber).join(', ')} – připraveno ke schválení. Doklady zůstávají otevřené, nic se neschválilo ani nepředalo účetní.`,
      });
      setBulkSelected(new Set());
    } else {
      setBulkResult({ kind: 'error', text: outcomeMessage(vm, outcome) });
    }
  },
);

const useRecurringPanel = (vm: FinanceViewModel) => {
  const templates = vm.snapshot?.state.recurringTemplates ?? [];
  const invoices = vm.snapshot?.state.invoices ?? [];
  const nextMonth = addMonths(monthOf(vm.referenceDate === '' ? '2026-10-20' : vm.referenceDate), 1);
  const [period, setPeriod] = useState(nextMonth);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<TemplateDraft>(emptyTemplate);
  const [formError, setFormError] = useState<string>();
  const [result, setResult] = useState<GenerationResult>();
  const [duplicateTarget, setDuplicateTarget] = useState<RecurringTemplate>();
  const [running, setRunning] = useState(false);
  const [bulkSelected, setBulkSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulkResult, setBulkResult] = useState<{ readonly kind: 'error' | 'success'; readonly text: string }>();
  const { customers } = vm.references;
  const set = (patch: Partial<TemplateDraft>) => setDraft((current) => ({ ...current, ...patch }));

  const generated = (template: RecurringTemplate) =>
    invoices.filter((invoice) => invoice.recurringTemplateId === template.id && invoice.businessState !== 'VOIDED');

  const generate = (targets: readonly RecurringTemplate[]): void => {
    void financeBrowserRuntime.runPromise(
      recurringPanelGenerateProgram({ period, setDuplicateTarget, setResult, setRunning, vm }, targets),
    );
  };

  const generateDuplicate = (): void => {
    void financeBrowserRuntime.runPromise(
      recurringPanelGenerateDuplicateProgram({ duplicateTarget, period, setDuplicateTarget, setResult, vm }),
    );
  };

  const createTemplate = (): void => {
    void financeBrowserRuntime.runPromise(
      recurringPanelCreateTemplateProgram({ customers, draft, setCreating, setDraft, setFormError, vm }),
    );
  };

  const active = templates.filter((template) => template.active);
  const recurringDrafts = invoices.filter(
    (invoice) =>
      invoice.businessState === 'DRAFT' &&
      (invoice.recurringTemplateId !== undefined || invoice.documentKind === 'RECURRING'),
  );
  const selectable = recurringDrafts.filter((invoice) => invoice.reviewState !== 'PREPARED');
  const selectedDrafts = selectable.filter((invoice) => bulkSelected.has(invoice.ref.resourceId));
  const toggleDraft = (id: string) =>
    setBulkSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  const prepareSelected = (): void => {
    void financeBrowserRuntime.runPromise(
      recurringPanelPrepareSelectedProgram({ selectedDrafts, setBulkResult, setBulkSelected, vm }),
    );
  };
  const periodOptions = Array.from({ length: 6 }, (_, index) => addMonths(nextMonth, index - 1));

  return {
    active,
    bulkResult,
    bulkSelected,
    createTemplate,
    creating,
    customers,
    draft,
    duplicateTarget,
    formError,
    generate,
    generated,
    generateDuplicate,
    invoices,
    nextMonth,
    period,
    periodOptions,
    prepareSelected,
    recurringDrafts,
    result,
    running,
    selectable,
    selectedDrafts,
    set,
    setBulkResult,
    setBulkSelected,
    setCreating,
    setDraft,
    setDuplicateTarget,
    setFormError,
    setPeriod,
    setResult,
    setRunning,
    templates,
    toggleDraft,
    vm,
  };
};

const RecurringGeneration = (model: ReturnType<typeof useRecurringPanel>) => {
  const { active, generate, period, periodOptions, result, running, setCreating, setPeriod, setResult, vm } = model;
  return (
    <SectionCard
      actions={
        vm.canWrite ? (
          <>
            <div className="w-44">
              <SelectTemplate
                aria-label="Období"
                items={periodOptions.map((month) => ({
                  displayValue: monthLabel(month),
                  label: monthLabel(month),
                  value: month,
                }))}
                onValueChange={({ value }) => {
                  const [next] = value;
                  if (next !== undefined) {
                    setPeriod(next);
                    setResult(undefined);
                  }
                }}
                size="sm"
                value={[period]}
              />
            </div>
            <Button
              disabled={active.length === 0 || running}
              icon="icon-[mdi--file-multiple-outline]"
              isLoading={running}
              loadingText="Připravuji…"
              onClick={() => {
                generate(active);
              }}
              size="sm"
              variant="primary"
            >
              Připravit návrhy za období ({active.length})
            </Button>
            <Button
              icon="icon-[mdi--plus]"
              onClick={() => setCreating(true)}
              size="sm"
              theme="outlined"
              variant="secondary"
            >
              Nová šablona
            </Button>
          </>
        ) : undefined
      }
      title="Opakované faktury (nájemné)"
    >
      <p className="text-fg-secondary text-sm">
        Šablona + období + ruční spuštění vytvoří nový <strong>návrh</strong> faktury. Druhý návrh pro stejné období
        systém nevytvoří bez výslovného potvrzení. Vybrané návrhy níže hromadně přepnete k odsouhlasení – schválení
        (vystavení) a předání účetní zůstávají samostatnými kroky.
      </p>
      {result !== undefined && (
        <div className="flex flex-col gap-100">
          {result.created.length > 0 && (
            <StatusText showIcon size="sm" status="success">
              Vytvořeno {result.created.length} návrhů za {monthLabel(period)}: {result.created.join(', ')}
            </StatusText>
          )}
          {result.duplicates.length > 0 && (
            <StatusText showIcon size="sm" status="warning">
              Přeskočeno kvůli ochraně proti duplicitě ({monthLabel(period)} už existuje):{' '}
              {result.duplicates.map((template) => template.name).join(', ')}
            </StatusText>
          )}
          {result.failed.map((failure) => (
            <StatusText key={failure} showIcon size="sm" status="error">
              {failure}
            </StatusText>
          ))}
        </div>
      )}
    </SectionCard>
  );
};

const RecurringTemplates = (model: ReturnType<typeof useRecurringPanel>) => {
  const { generate, generated, period, running, templates, vm } = model;
  return templates.length === 0 ? (
    <EmptyState
      description="Založte šablonu pro pravidelné nájemné a jedním klikem připravte návrhy faktur za měsíc."
      title="Zatím žádná šablona"
    />
  ) : (
    <SectionCard flush>
      <FinanceTableScroll label="Opakované faktury – šablony">
        <Table size="sm" variant="line">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeader>Šablona</Table.ColumnHeader>
              <Table.ColumnHeader>Nájemce</Table.ColumnHeader>
              <Table.ColumnHeader align="end">Měsíčně s DPH</Table.ColumnHeader>
              <Table.ColumnHeader>Vystavení / splatnost</Table.ColumnHeader>
              <Table.ColumnHeader>Vygenerovaná období</Table.ColumnHeader>
              <Table.ColumnHeader>Stav</Table.ColumnHeader>
              <Table.ColumnHeader align="end">Akce</Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {templates.map((template) => {
              const periods = [...new Set(generated(template).map((invoice) => invoice.recurringPeriod ?? ''))]
                .filter((value) => value !== '')
                .toSorted();
              return (
                <Table.Row key={template.id}>
                  <Table.Cell>
                    <span className="flex flex-col">
                      <span className="font-medium">{template.name}</span>
                      <span className="text-fg-secondary text-xs">{template.lines[0]?.description}</span>
                    </span>
                  </Table.Cell>
                  <Table.Cell>
                    {vm.references.customerById.get(template.partyId ?? template.counterpartyRef.resourceId)
                      ?.displayName ??
                      template.counterpartyName ??
                      '—'}
                  </Table.Cell>
                  <Table.Cell align="end" className="tabular-nums">
                    {formatMoney(templateTotal(template))}
                  </Table.Cell>
                  <Table.Cell>
                    {template.issueDay}. den v měsíci · {formatCzechDays(template.dueDays)}
                  </Table.Cell>
                  <Table.Cell>
                    <span className="flex flex-wrap gap-50">
                      {periods.length === 0
                        ? '—'
                        : periods.map((value) => (
                            <Badge key={value} size="sm" variant={value === period ? 'primary' : 'info'}>
                              {value}
                            </Badge>
                          ))}
                    </span>
                  </Table.Cell>
                  <Table.Cell>
                    <Badge size="sm" variant={template.active ? 'success' : 'warning'}>
                      {template.active ? 'Aktivní' : 'Pozastavená'}
                    </Badge>
                  </Table.Cell>
                  <Table.Cell align="end">
                    {vm.canWrite && (
                      <span className="flex flex-wrap justify-end gap-50">
                        {template.active && (
                          <Button
                            className="whitespace-nowrap"
                            disabled={running}
                            onClick={() => {
                              generate([template]);
                            }}
                            size="sm"
                            theme="outlined"
                            variant="secondary"
                          >
                            Připravit {period}
                          </Button>
                        )}
                        <Button
                          onClick={() => {
                            void financeBrowserRuntime.runPromise(
                              vm.execute(
                                {
                                  _tag: 'SetRecurringTemplateActive',
                                  active: !template.active,
                                  templateId: template.id,
                                },
                                template.active ? 'Šablona pozastavena' : 'Šablona obnovena',
                              ),
                            );
                          }}
                          size="sm"
                          theme="borderless"
                          variant="secondary"
                        >
                          {template.active ? 'Pozastavit' : 'Obnovit'}
                        </Button>
                      </span>
                    )}
                  </Table.Cell>
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table>
      </FinanceTableScroll>
    </SectionCard>
  );
};

const RecurringDrafts = (model: ReturnType<typeof useRecurringPanel>) => {
  const {
    bulkResult,
    bulkSelected,
    prepareSelected,
    recurringDrafts,
    selectable,
    selectedDrafts,
    setBulkSelected,
    toggleDraft,
    vm,
  } = model;
  return (
    <SectionCard
      actions={
        vm.canWrite ? (
          <Button
            disabled={selectedDrafts.length === 0 || vm.busy}
            icon="icon-[mdi--clipboard-check-multiple-outline]"
            onClick={() => {
              prepareSelected();
            }}
            size="sm"
            variant="primary"
          >
            Přepnout vybrané k odsouhlasení ({selectedDrafts.length})
          </Button>
        ) : undefined
      }
      flush
      title="Návrhy z opakovaných faktur"
    >
      <div className="flex flex-col gap-150 px-250 pb-150">
        <p className="text-fg-secondary text-sm">
          Hromadné zpracování jen připraví návrhy ke schválení. Účetně se tím nic neuzavírá.
        </p>
        {bulkResult !== undefined && (
          <StatusText showIcon size="sm" status={bulkResult.kind}>
            {bulkResult.text}
          </StatusText>
        )}
      </div>
      {recurringDrafts.length === 0 ? (
        <p className="px-250 pb-250 text-fg-secondary text-sm">Žádné otevřené návrhy z opakovaných faktur.</p>
      ) : (
        <FinanceTableScroll label="Návrhy z opakovaných faktur">
          <Table size="sm" variant="line">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>
                  <Checkbox
                    aria-label="Vybrat všechny návrhy"
                    checked={
                      selectable.length > 0 && selectable.every((invoice) => bulkSelected.has(invoice.ref.resourceId))
                    }
                    disabled={selectable.length === 0}
                    onChange={(event) =>
                      setBulkSelected(
                        event.target.checked ? new Set(selectable.map((invoice) => invoice.ref.resourceId)) : new Set(),
                      )
                    }
                  />
                </Table.ColumnHeader>
                <Table.ColumnHeader>Doklad</Table.ColumnHeader>
                <Table.ColumnHeader>Nájemce</Table.ColumnHeader>
                <Table.ColumnHeader>Období</Table.ColumnHeader>
                <Table.ColumnHeader>Vystavení</Table.ColumnHeader>
                <Table.ColumnHeader align="end">Celkem</Table.ColumnHeader>
                <Table.ColumnHeader>Stav</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {recurringDrafts.map((invoice) => {
                const presentation = LIFECYCLE_PRESENTATION[invoiceLifecycle(invoice)];
                const prepared = invoice.reviewState === 'PREPARED';
                return (
                  <Table.Row key={invoice.ref.resourceId}>
                    <Table.Cell>
                      <Checkbox
                        aria-label={`Vybrat ${invoice.number ?? invoice.documentNumber}`}
                        checked={!prepared && bulkSelected.has(invoice.ref.resourceId)}
                        disabled={prepared}
                        onChange={() => toggleDraft(invoice.ref.resourceId)}
                      />
                    </Table.Cell>
                    <Table.Cell className="whitespace-nowrap font-medium">
                      <a className="underline" href={`?resourceId=${encodeURIComponent(invoice.ref.resourceId)}`}>
                        {invoice.number ?? invoice.documentNumber}
                      </a>
                    </Table.Cell>
                    <Table.Cell>
                      {vm.references.customerById.get(invoice.partyId ?? invoice.counterpartyRef.resourceId)
                        ?.displayName ??
                        invoice.counterpartyName ??
                        '—'}
                    </Table.Cell>
                    <Table.Cell>
                      {invoice.recurringPeriod === undefined ? '—' : monthLabel(invoice.recurringPeriod)}
                    </Table.Cell>
                    <Table.Cell>{formatDate(invoice.issueDate)}</Table.Cell>
                    <Table.Cell align="end" className="tabular-nums">
                      {formatMoney(invoice.totalMinor)}
                    </Table.Cell>
                    <Table.Cell>
                      <Badge className="whitespace-nowrap" size="sm" variant={presentation.variant}>
                        {presentation.label}
                      </Badge>
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
        </FinanceTableScroll>
      )}
    </SectionCard>
  );
};

const RecurringDuplicateDecision = (model: ReturnType<typeof useRecurringPanel>) => {
  const { duplicateTarget, generateDuplicate, period, setDuplicateTarget, vm } = model;
  return (
    <Dialog
      actions={
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', justifyContent: 'flex-end', width: '100%' }}>
          <Button
            className="whitespace-nowrap"
            onClick={() => setDuplicateTarget(undefined)}
            theme="outlined"
            variant="secondary"
          >
            Nevytvářet
          </Button>
          <Button
            className="whitespace-nowrap"
            disabled={vm.busy}
            onClick={() => {
              generateDuplicate();
            }}
            variant="danger"
          >
            Přesto vytvořit druhý návrh
          </Button>
        </div>
      }
      closeLabel={dialogCloseLabel}
      customTrigger
      description={`Pro šablonu „${duplicateTarget?.name ?? ''}“ už existuje faktura za ${monthLabel(period)}. Opravdu chcete vytvořit další návrh pro stejné období?`}
      onOpenChange={(details) => {
        if (!details.open) {
          setDuplicateTarget(undefined);
        }
      }}
      open={duplicateTarget !== undefined}
      placement="center"
      role="alertdialog"
      size="sm"
      title="Možná duplicita"
    />
  );
};

const RecurringTemplateEditor = (model: ReturnType<typeof useRecurringPanel>) => {
  const { createTemplate, creating, customers, draft, formError, set, setCreating, vm } = model;
  return (
    <SidePanel
      actions={
        <>
          <Button onClick={() => setCreating(false)} theme="outlined" variant="secondary">
            Zrušit
          </Button>
          <Button
            isLoading={vm.busy}
            onClick={() => {
              createTemplate();
            }}
            variant="primary"
          >
            Uložit šablonu
          </Button>
        </>
      }
      closeOnInteractOutside={false}
      description="Pravidelná měsíční faktura, např. nájemné za jednotku."
      onOpenChange={setCreating}
      open={creating}
      resizeLabel={vm.t('finance-billing.sidePanel.resize')}
      size="lg"
      title="Nová šablona opakované faktury"
    >
      <form
        className="flex flex-col gap-200 py-200"
        onSubmit={(event) => {
          event.preventDefault();
          createTemplate();
        }}
      >
        {formError !== undefined && (
          <StatusText showIcon size="sm" status="error">
            {formError}
          </StatusText>
        )}
        {customers.length === 0 && (
          <StatusText showIcon size="sm" status="warning">
            V adresáři zatím není žádný zákazník (nájemce). Založte jej nejprve v sekci Zákazníci.
          </StatusText>
        )}
        <SelectTemplate
          items={customers.map((customer) => ({
            displayValue: customer.displayName ?? customer.partyId,
            label: customer.displayName ?? customer.partyId,
            value: customer.partyId,
          }))}
          label="Nájemce"
          labelProps={{ className: 'font-label text-label-md' }}
          onValueChange={({ value }) => {
            const [next] = value;
            if (next !== undefined) {
              set({ customerId: next });
            }
          }}
          placeholder="Vyberte nájemce"
          size="sm"
          value={draft.customerId === '' ? [] : [draft.customerId]}
        />
        <FormInput
          id="template-name"
          label="Název šablony"
          onChange={(event) => set({ name: event.target.value })}
          placeholder="např. Nájem – kancelář 2.04"
          size="sm"
          value={draft.name}
        />
        <FormInput
          id="template-line"
          label="Text položky na faktuře"
          onChange={(event) => set({ description: event.target.value })}
          size="sm"
          value={draft.description}
        />
        <div className="grid grid-cols-1 gap-200 md:grid-cols-2">
          <FormInput
            helpText={
              parseAmountMinor(draft.amount) === undefined
                ? 'Částka bez DPH'
                : `s DPH ${formatMoney(Math.round((parseAmountMinor(draft.amount) ?? 0) * (1 + draft.vatRate / 100)))}`
            }
            id="template-amount"
            inputMode="decimal"
            label="Měsíční částka bez DPH (Kč)"
            onChange={(event) => set({ amount: event.target.value })}
            size="sm"
            value={draft.amount}
          />
          <SelectTemplate
            items={[21, 12, 0].map((rate) => ({
              displayValue: `${rate} %`,
              label: `${rate} %`,
              value: String(rate),
            }))}
            label="Sazba DPH"
            labelProps={{ className: 'font-label text-label-md' }}
            onValueChange={({ value }) => {
              const [next] = value;
              if (next === '21' || next === '12' || next === '0') {
                const vatRate = VAT_RATE_CHOICES.find((rate) => String(rate) === next);
                if (vatRate !== undefined) {
                  set({ vatRate });
                }
              }
            }}
            size="sm"
            value={[String(draft.vatRate)]}
          />
        </div>
        <div className="grid grid-cols-1 gap-200 md:grid-cols-2">
          <FormInput
            id="template-issue-day"
            inputMode="numeric"
            label="Den vystavení v měsíci (1–28)"
            onChange={(event) => set({ issueDay: event.target.value })}
            size="sm"
            value={draft.issueDay}
          />
          <FormInput
            id="template-due-days"
            inputMode="numeric"
            label="Splatnost (dní)"
            onChange={(event) => set({ dueDays: event.target.value })}
            size="sm"
            value={draft.dueDays}
          />
        </div>
      </form>
    </SidePanel>
  );
};

export const RecurringPanel = ({ vm }: { readonly vm: FinanceViewModel }) => {
  const model = useRecurringPanel(vm);
  return (
    <div className="flex flex-col gap-250">
      <RecurringGeneration {...model} />
      <RecurringTemplates {...model} />
      <RecurringDrafts {...model} />
      <RecurringDuplicateDecision {...model} />
      <RecurringTemplateEditor {...model} />
    </div>
  );
};
