import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { InventorySourceAssertionProposalSchema } from '../../shared/domain/inventory-source-assertion.ts';
import {
  compareInventorySourceOrdering,
  inventorySourceAssertionsClaimSameIdentityOrRevision,
  inventorySourceAssertionsHaveSameMaterialContent,
} from '../../shared/domain/inventory-source-ordering.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const assertionId = '22222222-2222-4222-8222-222222222222';
const decodeProposal = Schema.decodeUnknownSync(InventorySourceAssertionProposalSchema, { onExcessProperty: 'error' });
const proposal = (input?: Partial<typeof InventorySourceAssertionProposalSchema.Encoded>) =>
  decodeProposal({
    assertionId,
    businessObservedAt: '2026-09-24T10:00:00.000Z',
    coverage: [],
    customerConfigurationId: 'customer-configuration:primary',
    factMeaning: 'ABSOLUTE_PHYSICAL_ON_HAND',
    issuer: { backendId: 'erp-a', backendKind: 'external_business_system' },
    itemExternalKey: {
      customerConfigurationId: 'customer-configuration:primary',
      externalScope: 'warehouse:prague',
      externalValue: 'ITEM-123',
      identifierKind: 'ITEM',
      issuer: { backendId: 'erp-a', backendKind: 'external_business_system' },
      namespace: 'inventory',
      tenantId,
    },
    locationExternalKey: {
      customerConfigurationId: 'customer-configuration:primary',
      externalScope: 'warehouse:prague',
      externalValue: 'LOC-123',
      identifierKind: 'LOCATION',
      issuer: { backendId: 'erp-a', backendKind: 'external_business_system' },
      namespace: 'inventory',
      tenantId,
    },
    orderingEvidence: { _tag: 'SOURCE_REVISION', revision: '2' },
    ownerEvidenceRef: 'erp-a:snapshot:2',
    positionRef: {
      moduleId: 'commerce.inventory',
      resourceId: '33333333-3333-4333-8333-333333333333',
      resourceType: 'commerce.inventory.stock-position',
      tenantId,
    },
    quantity: {
      amount: '8',
      unitRef: {
        moduleId: 'commerce.catalog',
        resourceId: '44444444-4444-4444-8444-444444444444',
        resourceType: 'commerce.catalog.product-unit',
        tenantId,
      },
    },
    receivedAt: '2026-09-24T12:00:00.000Z',
    sourceReference: 'erp-a:warehouse:prague:snapshot:2',
    ...input,
  });

describe('Inventory source ordering', () => {
  it('orders decimal source revisions numerically and never by transport arrival', () => {
    expect(
      compareInventorySourceOrdering(
        { _tag: 'SOURCE_REVISION', revision: '2' },
        { _tag: 'SOURCE_REVISION', revision: '10' },
      ),
    ).toBe('OLDER');
    expect(
      compareInventorySourceOrdering(
        { _tag: 'SOURCE_REVISION', revision: '000010' },
        { _tag: 'SOURCE_REVISION', revision: '10' },
      ),
    ).toBe('SAME');
  });

  it('fails closed when two owner evidences do not define a common order', () => {
    expect(
      compareInventorySourceOrdering(
        { _tag: 'SOURCE_REVISION', revision: 'release-blue' },
        { _tag: 'SOURCE_REVISION', revision: 'release-green' },
      ),
    ).toBe('INCOMPARABLE');
    expect(
      compareInventorySourceOrdering(
        { _tag: 'SOURCE_REVISION', revision: '2' },
        { _tag: 'OWNER_ORDER_KEY', key: '0002' },
      ),
    ).toBe('INCOMPARABLE');
  });

  it('compares material business fields and ignores delivery identity, arrival time, and coverage order', () => {
    const first = proposal({
      coverage: [
        {
          assertionId,
          effectId: '55555555-5555-4555-8555-555555555555',
          ownerEvidenceRef: 'coverage:one',
          relation: 'INCLUDES',
        },
        {
          assertionId,
          effectId: '66666666-6666-4666-8666-666666666666',
          ownerEvidenceRef: 'coverage:two',
          relation: 'EXCLUDES',
        },
      ],
    });
    const retryId = '77777777-7777-4777-8777-777777777777';
    const retry = proposal({
      assertionId: retryId,
      coverage: [
        {
          assertionId: retryId,
          effectId: '66666666-6666-4666-8666-666666666666',
          ownerEvidenceRef: 'coverage:two',
          relation: 'EXCLUDES',
        },
        {
          assertionId: retryId,
          effectId: '55555555-5555-4555-8555-555555555555',
          ownerEvidenceRef: 'coverage:one',
          relation: 'INCLUDES',
        },
      ],
      receivedAt: '2026-09-24T13:00:00.000Z',
    });

    expect(inventorySourceAssertionsHaveSameMaterialContent(first, retry)).toBe(true);
    expect(inventorySourceAssertionsClaimSameIdentityOrRevision(first, retry)).toBe(true);
    expect(
      inventorySourceAssertionsHaveSameMaterialContent(
        first,
        proposal({ quantity: { ...first.quantity, amount: '12' } }),
      ),
    ).toBe(false);
  });

  it('normalizes equivalent numeric revisions and business instants before duplicate comparison', () => {
    const canonical = proposal({
      businessObservedAt: '2026-09-24T10:00:00.000Z',
      orderingEvidence: { _tag: 'SOURCE_REVISION', revision: '10' },
    });
    const equivalent = proposal({
      businessObservedAt: '2026-09-24T12:00:00.000+02:00',
      orderingEvidence: { _tag: 'SOURCE_REVISION', revision: '000010' },
    });

    expect(compareInventorySourceOrdering(canonical.orderingEvidence, equivalent.orderingEvidence)).toBe('SAME');
    expect(inventorySourceAssertionsHaveSameMaterialContent(canonical, equivalent)).toBe(true);
    expect(inventorySourceAssertionsClaimSameIdentityOrRevision(canonical, equivalent)).toBe(true);
  });

  it('keeps owner-defined order keys representation-exact', () => {
    const padded = proposal({ orderingEvidence: { _tag: 'OWNER_ORDER_KEY', key: '000010' } });
    const compact = proposal({ orderingEvidence: { _tag: 'OWNER_ORDER_KEY', key: '10' } });

    expect(compareInventorySourceOrdering(padded.orderingEvidence, compact.orderingEvidence)).toBe('OLDER');
    expect(inventorySourceAssertionsHaveSameMaterialContent(padded, compact)).toBe(false);
  });
});
