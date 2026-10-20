import { FinanceTableScroll } from './finance-table-scroll.tsx';
import { formatCzechDays } from '@app/shared-contracts';
// @effect-diagnostics asyncFunction:off
// @effect-diagnostics newPromise:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
import { dialogCloseLabel, EmptyState, formatMoney, SectionCard, SidePanel } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Table } from '@techsio/ui-kit/organisms/table';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { useState } from 'react';
import type { RecurringTemplate, VatRate } from '../../../../../shared/apis/records.ts';
import { addMonths, monthOf } from '../../../../../shared/domain/finance-planning.ts';
import { computeInvoiceTotals } from '../../../../../shared/domain/invoice-totals.ts';
import { monthLabel, outcomeMessage, parseAmountMinor } from './finance-ui.tsx';
import type { FinanceViewModel } from './finance-ui.tsx';

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
export const RecurringPanel = ({ vm }: { readonly vm: FinanceViewModel }) => {
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
  const customers = vm.references.customers;
  const set = (patch: Partial<TemplateDraft>) => setDraft((current) => ({ ...current, ...patch }));

  const generated = (template: RecurringTemplate) =>
    invoices.filter((invoice) => invoice.recurringTemplateId === template.id && invoice.businessState !== 'VOIDED');

  const generate = async (targets: readonly RecurringTemplate[]) => {
    setRunning(true);
    const created: string[] = [];
    const duplicates: RecurringTemplate[] = [];
    const failed: string[] = [];
    for (const template of targets) {
      const outcome = await vm.execute({
        _tag: 'GenerateRecurringInvoice',
        confirmDuplicate: false,
        period,
        templateId: template.id,
      });
      if (outcome.ok) {
        created.push(outcome.invoice?.number ?? template.name);
      } else if (outcome.reason?.includes('recurring_period_already_generated') === true) {
        duplicates.push(template);
      } else {
        failed.push(`${template.name}: ${outcomeMessage(vm, outcome)}`);
      }
    }
    setRunning(false);
    setResult({ created, duplicates, failed });
    if (targets.length === 1 && duplicates.length === 1) {
      setDuplicateTarget(duplicates[0]);
    }
  };

  const generateDuplicate = async () => {
    if (duplicateTarget === undefined) {
      return;
    }
    const outcome = await vm.execute(
      { _tag: 'GenerateRecurringInvoice', confirmDuplicate: true, period, templateId: duplicateTarget.id },
      'Druhý návrh vytvořen na výslovné potvrzení',
    );
    setDuplicateTarget(undefined);
    if (outcome.ok) {
      setResult({ created: [outcome.invoice?.number ?? duplicateTarget.name], duplicates: [], failed: [] });
    }
  };

  const createTemplate = async () => {
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
    const outcome = await vm.execute(
      {
        _tag: 'CreateRecurringTemplate',
        ...(customer.displayName === null ? {} : { counterpartyName: customer.displayName }),
        counterpartyRef: customer.counterpartyRef,
        dueDays,
        issueDay,
        lines: [
          { description: draft.description.trim(), quantity: 1, unitPriceMinor: amountMinor, vatRate: draft.vatRate },
        ],
        name: draft.name.trim(),
        partyId: customer.partyId,
      },
      'Šablona opakované faktury uložena',
    );
    if (outcome.ok) {
      setCreating(false);
      setDraft(emptyTemplate);
      setFormError(undefined);
    } else {
      setFormError(outcomeMessage(vm, outcome));
    }
  };

  const active = templates.filter((template) => template.active);
  const periodOptions = Array.from({ length: 6 }, (_, index) => addMonths(nextMonth, index - 1));

  return (
    <div className="flex flex-col gap-250">
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
                onClick={() => void generate(active)}
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
          systém nevytvoří bez výslovného potvrzení. Návrhy se potvrzují (vystavují) jednotlivě v seznamu faktur.
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
      {templates.length === 0 ? (
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
                    .sort();
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
                                onClick={() => void generate([template])}
                                size="sm"
                                theme="outlined"
                                variant="secondary"
                              >
                                Připravit {period}
                              </Button>
                            )}
                            <Button
                              onClick={() =>
                                void vm.execute(
                                  {
                                    _tag: 'SetRecurringTemplateActive',
                                    active: !template.active,
                                    templateId: template.id,
                                  },
                                  template.active ? 'Šablona pozastavena' : 'Šablona obnovena',
                                )
                              }
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
      )}
      <Dialog
        actions={
          <>
            <Button onClick={() => setDuplicateTarget(undefined)} theme="outlined" variant="secondary">
              Nevytvářet
            </Button>
            <Button disabled={vm.busy} onClick={() => void generateDuplicate()} variant="danger">
              Přesto vytvořit druhý návrh
            </Button>
          </>
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
      <SidePanel
        actions={
          <>
            <Button onClick={() => setCreating(false)} theme="outlined" variant="secondary">
              Zrušit
            </Button>
            <Button isLoading={vm.busy} onClick={() => void createTemplate()} variant="primary">
              Uložit šablonu
            </Button>
          </>
        }
        closeOnInteractOutside={false}
        description="Pravidelná měsíční faktura, např. nájemné za jednotku."
        onOpenChange={setCreating}
        open={creating}
        resizeLabel={vm.t('siampark-billing-finance.sidePanel.resize')}
        size="lg"
        title="Nová šablona opakované faktury"
      >
        <form
          className="flex flex-col gap-200 py-200"
          onSubmit={(event) => {
            event.preventDefault();
            void createTemplate();
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
                  set({ vatRate: Number(next) as VatRate });
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
    </div>
  );
};
