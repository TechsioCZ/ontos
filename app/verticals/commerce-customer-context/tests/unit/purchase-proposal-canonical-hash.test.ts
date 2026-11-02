import { CoreSearchResourceRefSchema } from '@app/core-runtime';
import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { MonetaryAmountSchema } from '../../shared/domain/purchase-limit.ts';
import {
  PurchaseProposalRevisionSchema,
  computePurchaseProposalCanonicalHash,
} from '../../shared/domain/purchasing-approval.ts';
import { purchasingApprovalCommercialFixture } from './purchasing-approval-fixtures.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const buyerId = '10000000-0000-4000-8000-000000000002';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const atText = '2026-09-09T12:00:00.000Z';
const expiresAtText = '2026-09-09T13:00:00.000Z';

const counterpartyRef = Schema.decodeUnknownSync(CoreSearchResourceRefSchema)({
  moduleId: 'party.registry',
  resourceId: 'counterparty-1',
  resourceType: 'party.registry.counterparty',
  tenantId,
});
const money = (amount: string) => Schema.decodeUnknownSync(MonetaryAmountSchema)({ amount, currency: 'EUR' });

const commercial = purchasingApprovalCommercialFixture({ money, tenantId });

type Configuration = Readonly<Record<string, Schema.Json>>;

const proposalWith = (configuration: Configuration) =>
  Schema.decodeUnknownSync(PurchaseProposalRevisionSchema)({
    approvalEvaluation: 'APPROVAL_REQUIRED',
    approvalTrigger: { policyRevision: 'limit-r1', reasonCode: 'over_limit', source: 'PURCHASE_LIMIT' },
    canonicalHash: 'a'.repeat(64),
    canonicalizationVersion: 'purchase-proposal.v1',
    context: {
      channelId: 'portal',
      evaluatedAt: atText,
      locale: 'en-US',
      marketId: 'eu',
      sellingLegalEntityId: legalEntityId,
      storefrontId: 'storefront-eu',
      tenantId,
    },
    createdAt: atText,
    currency: 'EUR',
    deliveryDestination: { address: { country: 'CZ' }, kind: 'DELIVERY', method: 'DELIVERY_ADDRESS' },
    effectiveLimit: money('50'),
    expiresAt: expiresAtText,
    hierarchyInputs: {
      counterpartyRef,
      evaluatedAt: atText,
      purchaseValue: money('120'),
      storefrontId: 'storefront-eu',
    },
    identity: {
      buyer: { principalId: buyerId, tenantId },
      counterpartyRef,
      profileRef: {
        moduleId: 'commerce.customer-context',
        resourceId: 'profile-1',
        resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
        tenantId,
      },
    },
    invoiceRecipient: { address: { country: 'CZ' }, kind: 'INVOICE', method: 'BILLING_ADDRESS' },
    ...commercial,
    lines: commercial.lines.map((line) => ({ ...line, configuration })),
    payment: 'NONE',
    paymentTerm: {
      code: 'NET30',
      definitionRef: {
        moduleId: 'payment-term-catalog',
        resourceId: 'net-30',
        resourceType: 'payment-term-catalog.payment-term-definition',
        tenantId,
      },
      definitionRevision: '1',
    },
    policyRefs: [],
    pricingRevision: 'pricing-r1',
    proposalRevisionRef: {
      moduleId: 'commerce.customer-context',
      resourceId: 'proposal-1',
      resourceType: 'commerce.customer-context.purchase-proposal-revision',
      tenantId,
    },
    proposalSequence: 1,
    reservation: 'NONE',
    revision: 1,
    state: 'CURRENT',
    taxRevision: 'tax-r1',
  });

// Builds a configuration whose property insertion order is exactly the given entry order.
const inOrder = (entries: readonly (readonly [string, Schema.Json])[]): Configuration => Object.fromEntries(entries);

const hashOf = (configuration: Configuration) => computePurchaseProposalCanonicalHash(proposalWith(configuration));

describe('Purchase proposal canonical hash', () => {
  it('produces a lowercase SHA-256 hex digest', () => {
    expect(hashOf({ color: 'red' })).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('is identical for configurations that differ only in top-level key order', () => {
    const forward = inOrder([
      ['alpha', 1],
      ['beta', 'two'],
      ['gamma', true],
    ]);
    const backward = inOrder([
      ['gamma', true],
      ['beta', 'two'],
      ['alpha', 1],
    ]);
    expect(JSON.stringify(backward)).not.toBe(JSON.stringify(forward));
    expect(hashOf(forward)).toBe(hashOf(backward));
  });

  it('is identical for configurations that differ only in nested key order', () => {
    const first = {
      list: [
        inOrder([
          ['k1', 1],
          ['k2', 2],
        ]),
      ],
      outer: inOrder([
        ['a', 1],
        [
          'b',
          inOrder([
            ['x', 'x'],
            ['y', 'y'],
          ]),
        ],
      ]),
    };
    const reordered = {
      list: [
        inOrder([
          ['k2', 2],
          ['k1', 1],
        ]),
      ],
      outer: inOrder([
        [
          'b',
          inOrder([
            ['y', 'y'],
            ['x', 'x'],
          ]),
        ],
        ['a', 1],
      ]),
    };
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(first));
    expect(hashOf(first)).toBe(hashOf(reordered));
  });

  it.each(['deliveryDestination', 'invoiceRecipient'] as const)(
    'ignores %s address key order without ignoring address content',
    (destination) => {
      const proposal = proposalWith({ color: 'red' });
      const withAddress = (address: Readonly<Record<string, string>>) => ({
        ...proposal,
        [destination]: { ...proposal[destination], address },
      });
      const original = withAddress(
        Object.fromEntries([
          ['street', 'Main'],
          ['city', 'Prague'],
          ['country', 'CZ'],
        ]),
      );
      const reordered = withAddress({ city: 'Prague', country: 'CZ', street: 'Main' });
      expect(JSON.stringify(original[destination].address)).not.toBe(JSON.stringify(reordered[destination].address));
      expect(computePurchaseProposalCanonicalHash(original)).toBe(computePurchaseProposalCanonicalHash(reordered));
      expect(computePurchaseProposalCanonicalHash(original)).not.toBe(
        computePurchaseProposalCanonicalHash(withAddress({ city: 'Prague', country: 'CZ', street: 'Other' })),
      );
      expect(computePurchaseProposalCanonicalHash(original)).not.toBe(
        computePurchaseProposalCanonicalHash(withAddress({ country: 'CZ', street: 'Main', town: 'Prague' })),
      );
    },
  );

  it('is independent of the canonicalHash and state fields on the proposal', () => {
    const proposal = proposalWith({ color: 'red' });
    expect(
      computePurchaseProposalCanonicalHash({ ...proposal, canonicalHash: 'b'.repeat(64), state: 'CONSUMED' }),
    ).toBe(computePurchaseProposalCanonicalHash(proposal));
  });

  it('differs when a configuration value differs', () => {
    expect(hashOf({ color: 'red', size: 1 })).not.toBe(hashOf({ color: 'red', size: 2 }));
    expect(hashOf({ outer: { inner: 'a' } })).not.toBe(hashOf({ outer: { inner: 'b' } }));
  });

  it('differs when a configuration key differs', () => {
    expect(hashOf({ color: 'red' })).not.toBe(hashOf({ colour: 'red' }));
  });

  it('keeps array element order significant', () => {
    expect(hashOf({ options: ['a', 'b', 'c'] })).not.toBe(hashOf({ options: ['c', 'b', 'a'] }));
    expect(hashOf({ options: [{ a: 1 }, { b: 2 }] })).not.toBe(hashOf({ options: [{ b: 2 }, { a: 1 }] }));
  });
});
