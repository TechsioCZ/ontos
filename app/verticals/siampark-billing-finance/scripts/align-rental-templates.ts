import type { FinanceState, Invoice, RecurringTemplate } from '../shared/apis/records.ts';
import { computeInvoiceTotals } from '../shared/domain/invoice-totals.ts';

/** Synthetic demo repair only: use the rental lane's anchored invoice as the single source of rent terms. */
export const alignRentalTemplates = (state: FinanceState): FinanceState => {
  const sources = new Map<string, Invoice>();
  for (const unit of ['R101', 'R201', 'A101']) {
    const source = state.invoices.find(
      (invoice) => invoice.documentNumber.startsWith(`NAJ-${unit}-`) && invoice.occupancyRef !== undefined,
    );
    if (source !== undefined) sources.set(unit, source);
  }
  const templates = (state.recurringTemplates ?? []).map((template): RecurringTemplate => {
    const unit = [...sources.keys()].find((code) => template.name.includes(code));
    const source = unit === undefined ? undefined : sources.get(unit);
    if (source === undefined || source.lines === undefined) return template;
    const name = state.invoices.find(
      (invoice) =>
        invoice.counterpartyRef.resourceId === source.counterpartyRef.resourceId &&
        invoice.counterpartyName !== undefined,
    )?.counterpartyName;
    return {
      ...template,
      // A101 tenancy ends in October. Do not offer a November draft without a renewed lease.
      active: unit === 'A101' ? false : template.active,
      ...(source.contractRef === undefined ? {} : { contractRef: source.contractRef }),
      ...((name ?? source.counterpartyName) === undefined
        ? {}
        : { counterpartyName: name ?? source.counterpartyName! }),
      counterpartyRef: source.counterpartyRef,
      dueDays: unit === 'R101' ? 9 : unit === 'R201' ? 14 : 4,
      lines: source.lines.map((line) => ({ ...line, description: line.description.replace(/ – .+$/u, '') })),
      name:
        unit === 'R101'
          ? 'Nájem R101 – kavárna a služby'
          : unit === 'R201'
            ? 'Nájem R201 – kancelář a služby'
            : 'Nájem A101 – služební byt (do října)',
      ...(source.occupancyRef === undefined ? {} : { occupancyRef: source.occupancyRef }),
      ...(source.partyId === undefined ? {} : { partyId: source.partyId }),
      ...(source.propertyRef === undefined ? {} : { propertyRef: source.propertyRef }),
      ...(source.unitRef === undefined ? {} : { unitRef: source.unitRef }),
    };
  });
  return {
    ...state,
    recurringTemplates: templates,
    invoices: state.invoices.map((invoice) => {
      // Never rewrite issued invoices, payment history or immutable accountant packages.
      const template = templates.find((entry) => entry.id === invoice.recurringTemplateId);
      if (template === undefined || invoice.businessState !== 'DRAFT') return invoice;
      return {
        ...invoice,
        ...computeInvoiceTotals(template.lines),
        ...(template.contractRef === undefined ? {} : { contractRef: template.contractRef }),
        ...(template.counterpartyName === undefined ? {} : { counterpartyName: template.counterpartyName }),
        counterpartyRef: template.counterpartyRef,
        dueDate: `${invoice.issueDate.slice(0, 8)}${String(1 + template.dueDays).padStart(2, '0')}`,
        lines: template.lines,
        ...(template.occupancyRef === undefined ? {} : { occupancyRef: template.occupancyRef }),
        ...(template.partyId === undefined ? {} : { partyId: template.partyId }),
        ...(template.propertyRef === undefined ? {} : { propertyRef: template.propertyRef }),
        ...(template.unitRef === undefined ? {} : { unitRef: template.unitRef }),
        note: `Opakovaná faktura „${template.name}“ za období ${invoice.recurringPeriod ?? invoice.issueDate.slice(0, 7)}. DEMO: podmínky sjednoceny s nájmem.`,
      };
    }),
  };
};
