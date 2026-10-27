import { Match } from 'effect';
import type { FinanceState, Invoice, RecurringTemplate } from '../shared/apis/records.ts';
import { computeInvoiceTotals } from '../shared/domain/invoice-totals.ts';

type Mutable<Value> = { -readonly [Key in keyof Value]: Value[Key] };

const rentalTerms = (unit: string | undefined) =>
  Match.value(unit).pipe(
    Match.when('R101', () => ({ dueDays: 9, name: 'Nájem R101 – kavárna a služby' })),
    Match.when('R201', () => ({ dueDays: 14, name: 'Nájem R201 – kancelář a služby' })),
    Match.orElse(() => ({ dueDays: 4, name: 'Nájem A101 – služební byt (do října)' })),
  );

const alignTemplate = (
  state: FinanceState,
  sources: ReadonlyMap<string, Invoice>,
  template: RecurringTemplate,
): RecurringTemplate => {
  const unit = [...sources.keys()].find((code) => template.name.includes(code));
  const source = unit === undefined ? undefined : sources.get(unit);
  if (source === undefined || source.lines === undefined) {
    return template;
  }
  const name = state.invoices.find(
    (invoice) =>
      invoice.counterpartyRef.resourceId === source.counterpartyRef.resourceId &&
      invoice.counterpartyName !== undefined,
  )?.counterpartyName;
  const counterpartyName = name ?? source.counterpartyName;
  const aligned: Mutable<RecurringTemplate> = {
    ...template,
    // A101 tenancy ends in October. Do not offer a November draft without a renewed lease.
    active: unit === 'A101' ? false : template.active,
    counterpartyRef: source.counterpartyRef,
    ...rentalTerms(unit),
    lines: source.lines.map((line) => ({ ...line, description: line.description.replace(/ – .+$/u, '') })),
  };
  if (source.contractRef !== undefined) {
    aligned.contractRef = source.contractRef;
  }
  if (counterpartyName !== undefined) {
    aligned.counterpartyName = counterpartyName;
  }
  if (source.occupancyRef !== undefined) {
    aligned.occupancyRef = source.occupancyRef;
  }
  if (source.partyId !== undefined) {
    aligned.partyId = source.partyId;
  }
  if (source.propertyRef !== undefined) {
    aligned.propertyRef = source.propertyRef;
  }
  if (source.unitRef !== undefined) {
    aligned.unitRef = source.unitRef;
  }
  return aligned;
};

const alignDraft = (templates: readonly RecurringTemplate[], invoice: Invoice): Invoice => {
  // Never rewrite issued invoices, payment history or immutable accountant packages.
  const template = templates.find(
    (entry) =>
      entry.id === invoice.recurringTemplateId ||
      (invoice.documentNumber.startsWith('NAJ-') &&
        invoice.occupancyRef !== undefined &&
        entry.occupancyRef?.resourceId === invoice.occupancyRef.resourceId),
  );
  if (template === undefined || invoice.businessState !== 'DRAFT') {
    return invoice;
  }
  const aligned: Mutable<Invoice> = {
    ...invoice,
    ...computeInvoiceTotals(template.lines),
    counterpartyRef: template.counterpartyRef,
    documentKind: 'RECURRING',
    dueDate: `${invoice.issueDate.slice(0, 8)}${String(1 + template.dueDays).padStart(2, '0')}`,
    lines: template.lines,
    note: `Opakovaná faktura „${template.name}“ za období ${invoice.recurringPeriod ?? invoice.issueDate.slice(0, 7)}. DEMO: podmínky sjednoceny s nájmem.`,
    recurringPeriod: invoice.issueDate.slice(0, 7),
    recurringTemplateId: template.id,
  };
  if (template.contractRef !== undefined) {
    aligned.contractRef = template.contractRef;
  }
  if (template.counterpartyName !== undefined) {
    aligned.counterpartyName = template.counterpartyName;
  }
  if (template.occupancyRef !== undefined) {
    aligned.occupancyRef = template.occupancyRef;
  }
  if (template.partyId !== undefined) {
    aligned.partyId = template.partyId;
  }
  if (template.propertyRef !== undefined) {
    aligned.propertyRef = template.propertyRef;
  }
  if (template.unitRef !== undefined) {
    aligned.unitRef = template.unitRef;
  }
  return aligned;
};

/** Synthetic demo repair only: use the rental lane's anchored invoice as the single source of rent terms. */
export const alignRentalTemplates = (state: FinanceState): FinanceState => {
  const sources = new Map<string, Invoice>();
  for (const unit of ['R101', 'R201', 'A101']) {
    const source = state.invoices.find(
      (invoice) => invoice.documentNumber.startsWith(`NAJ-${unit}-`) && invoice.occupancyRef !== undefined,
    );
    if (source !== undefined) {
      sources.set(unit, source);
    }
  }
  const templates = (state.recurringTemplates ?? []).map((template) => alignTemplate(state, sources, template));
  return {
    ...state,
    invoices: state.invoices.map((invoice) => alignDraft(templates, invoice)),
    recurringTemplates: templates,
  };
};
