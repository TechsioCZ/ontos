import { Match } from 'effect';
import type { FinanceCommand } from '../actions/apply-command.ts';
import type { Invoice, RecurringTemplate } from '../apis/records.ts';

type InvoiceAnchors = Partial<Pick<Invoice, 'contractRef' | 'occupancyRef' | 'propertyRef' | 'taskRef' | 'unitRef'>>;

/**
 * Gateway audiences the backend validators read for one invoice. The counterparty is always checked in the party
 * registry; the Siampark modules are read only for anchors the invoice carries. Each credential is single use, so a
 * unit anchor needs its own property-module credential next to the property one. Requesting an audience that is not
 * part of the composition fails the whole command, so nothing else is listed.
 */
export const invoiceReferenceAudiences = (anchors: InvoiceAnchors): readonly string[] => [
  'party-registry',
  ...(anchors.propertyRef === undefined ? [] : ['siampark-property']),
  ...(anchors.unitRef === undefined ? [] : ['siampark-property']),
  ...(anchors.occupancyRef === undefined ? [] : ['siampark-occupancy']),
  ...(anchors.contractRef === undefined ? [] : ['siampark-agreements']),
  ...(anchors.taskRef === undefined ? [] : ['siampark-work']),
];

/** Audiences for a command: draft commands carry their anchors, the rest act on an invoice already in the list. */
export const MANUAL_COUNTERPARTY_RESOURCE_ID = '00000000-0000-4000-8000-000000000000';
const isManualCounterparty = (id: string) => id === MANUAL_COUNTERPARTY_RESOURCE_ID;

export const commandReferenceAudiences = (
  command: FinanceCommand,
  invoices: readonly Invoice[],
  templates: readonly RecurringTemplate[] = [],
): readonly string[] =>
  Match.value(command).pipe(
    Match.tag('CreateInvoiceDraft', 'UpdateInvoiceDraft', (draft) => invoiceReferenceAudiences(draft)),
    Match.tag('CreateInvoiceFromOpportunity', () => invoiceReferenceAudiences({})),
    // A manually typed supplier has no registry party to check; a picked registry supplier does.
    Match.tag('RecordIncomingInvoice', (incoming) =>
      incoming.counterpartyRef === undefined
        ? []
        : invoiceReferenceAudiences({
            ...(incoming.propertyRef === undefined ? {} : { propertyRef: incoming.propertyRef }),
          }),
    ),
    Match.tag('GenerateRecurringInvoice', (generate) => {
      const template = templates.find((entry) => entry.id === generate.templateId);
      if (template === undefined) {
        return [];
      }
      return isManualCounterparty(template.counterpartyRef.resourceId) ? [] : invoiceReferenceAudiences(template);
    }),
    // S08: the server reads partner IČO/DIČ/city for the handover file from the party registry itself.
    Match.tag('CreateAccountingExport', () => ['party-registry']),
    Match.tag(
      'AttachDocument',
      'SetInvoiceDetails',
      'RecordManualPayment',
      'RecordReminder',
      'CreateRecurringTemplate',
      'SetRecurringTemplateActive',
      'UpdateAccountingSetup',
      'ConfirmAccountingExport',
      'UpsertBudgetLine',
      'DeleteBudgetLine',
      'SetOpeningBalance',
      () => [],
    ),
    Match.orElse((targeted) =>
      invoiceReferenceAudiences(
        invoices.find(
          (invoice) =>
            invoice.ref.resourceId === targeted.invoiceRef.resourceId &&
            !isManualCounterparty(invoice.counterpartyRef.resourceId),
        ) ?? {},
      ),
    ),
  );

interface CounterpartyRolePeriod {
  readonly roleType: string;
  readonly state: string;
  readonly validFrom: string;
  readonly validTo: string | null;
}

/** Whether the counterparty holds an active role of the given type on the calendar date `on` (YYYY-MM-DD). */
export const hasUsableRole = (
  roles: readonly CounterpartyRolePeriod[],
  roleType: 'CUSTOMER' | 'SUPPLIER',
  on: string,
): boolean =>
  roles.some(
    (role) =>
      role.roleType === roleType &&
      role.state === 'ACTIVE' &&
      role.validFrom.slice(0, 10) <= on &&
      (role.validTo === null || role.validTo.slice(0, 10) > on),
  );
