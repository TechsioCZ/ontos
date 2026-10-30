import { DateTime, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { FinanceCommandSchema } from '../../shared/actions/apply-command.ts';
import type { FinanceCommand } from '../../shared/actions/apply-command.ts';
import type { Invoice } from '../../shared/apis/records.ts';
import { formatProblemReason, isProblemReason } from '../../shared/domain/problem-reason.ts';
import {
  commandReferenceAudiences,
  hasUsableRole,
  invoiceReferenceAudiences,
} from '../../shared/domain/reference-audiences.ts';

const tenantId = 'a0000000-0000-4000-8000-000000000001';
const resourceId = 'a0000000-0000-4000-8000-000000000099';
const now = DateTime.makeUnsafe('2026-10-13T08:00:00Z');
const counterpartyRef = {
  moduleId: 'party.registry' as const,
  resourceId,
  resourceType: 'party.registry.counterparty' as const,
  tenantId,
};
const propertyRef = {
  moduleId: 'property.portfolio' as const,
  resourceId,
  resourceType: 'property.portfolio.property' as const,
  tenantId,
};
const unitRef = {
  moduleId: 'property.portfolio' as const,
  resourceId,
  resourceType: 'property.portfolio.unit' as const,
  tenantId,
};
const invoiceRef = {
  moduleId: 'finance.billing' as const,
  resourceId: 'invoice-b201',
  resourceType: 'finance.billing.invoice' as const,
  tenantId,
};
const propertyInvoice: Invoice = {
  accountingCorrelation: 'accounting-b201',
  accountingSyncState: 'NOT_SYNCED',
  businessState: 'DRAFT',
  counterpartyRef,
  createdAt: now,
  currency: 'CZK',
  direction: 'OUTGOING',
  documentNumber: 'B201-2026-10',
  dueDate: '2026-10-27',
  issueDate: '2026-10-13',
  paidMinor: 0,
  paymentState: 'UNPAID',
  propertyRef,
  ref: invoiceRef,
  totalMinor: 1_800_000,
  updatedAt: now,
};

const manualDraft = {
  _tag: 'CreateInvoiceDraft',
  counterpartyRef,
  currency: 'CZK',
  direction: 'OUTGOING',
  documentNumber: 'FV-2026-0042',
  dueDate: '2026-10-27',
  issueDate: '2026-10-13',
  lines: [{ description: 'Školení', quantity: 1, unitPriceMinor: 100_000, vatRate: 21 }],
  partyId: 'party-c01',
} as const satisfies FinanceCommand;

describe('Finance reference credentials', () => {
  it('asks only the party registry for a manual customer invoice', () => {
    expect(commandReferenceAudiences(manualDraft, [])).toEqual(['party-registry']);
  });

  it('adds one single-use credential per Nájempark anchor the validators read', () => {
    expect(invoiceReferenceAudiences({ propertyRef, unitRef })).toEqual([
      'party-registry',
      'property-portfolio',
      'property-portfolio',
    ]);
  });

  it('derives anchors of invoice-targeted commands from the listed invoice', () => {
    const command = { _tag: 'ConfirmInvoice', invoiceRef } as const satisfies FinanceCommand;

    expect(commandReferenceAudiences(command, [propertyInvoice])).toEqual(['party-registry', 'property-portfolio']);
    expect(commandReferenceAudiences(command, [])).toEqual(['party-registry']);
  });

  it('lets the server read export partners from the party registry itself', () => {
    const command = Schema.decodeSync(FinanceCommandSchema)({
      _tag: 'CreateAccountingExport',
      format: 'POHODA_XML',
      invoiceResourceIds: ['a'],
    });

    expect(commandReferenceAudiences(command, [])).toEqual(['party-registry']);
  });
});

describe('Counterparty role validity', () => {
  const role = { roleType: 'CUSTOMER', state: 'ACTIVE', validFrom: '2026-10-13T08:00:00.000Z', validTo: null };

  it('accepts a customer whose role started today', () => {
    expect(hasUsableRole([role], 'CUSTOMER', '2026-10-13')).toBe(true);
  });

  it('rejects a role that starts later, has ended, or has the wrong type', () => {
    expect(hasUsableRole([role], 'CUSTOMER', '2026-10-05')).toBe(false);
    expect(hasUsableRole([{ ...role, validTo: '2026-10-13T00:00:00.000Z' }], 'CUSTOMER', '2026-10-13')).toBe(false);
    expect(hasUsableRole([role], 'SUPPLIER', '2026-10-13')).toBe(false);
  });
});

describe('Problem reason', () => {
  const rejection = {
    _tag: 'ApplyCommandActionIneligibleProblem',
    code: 'finance_rejected',
    detail: 'counterparty_role_not_usable',
    status: 422,
    title: 'Action ineligible',
    type: 'https://ontos.dev/problems/action-ineligible',
  };
  const gateway = { detail: 'The requested audience is not an available MicroVertical.', status: 400, title: 'x' };

  it('shows the problem detail with status and code', () => {
    expect(isProblemReason(rejection) && formatProblemReason(rejection)).toBe(
      'counterparty_role_not_usable (HTTP 422, finance_rejected)',
    );
    expect(isProblemReason(gateway) && formatProblemReason(gateway)).toBe(
      'The requested audience is not an available MicroVertical. (HTTP 400)',
    );
  });

  it('has no reason for failures without a problem response', () => {
    expect(isProblemReason(new Error('network down'))).toBe(false);
  });
});
