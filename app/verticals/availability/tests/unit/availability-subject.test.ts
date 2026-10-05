import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { AvailabilitySubjectSchema, sameAvailabilitySubject } from '../../shared/domain/availability-subject.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const foreignTenantId = '99999999-9999-4999-8999-999999999999';
const operationTime = '2026-10-05T12:00:00.000Z';
const ref = (resourceType: string, resourceId: string) => ({
  moduleId: 'commerce.catalog',
  resourceId,
  resourceType,
  tenantId,
});
const productRef = ref('commerce.catalog.product', '22222222-2222-4222-8222-222222222222');
const variantRef = ref('commerce.catalog.variant', '33333333-3333-4333-8333-333333333333');
const unitRef = ref('commerce.catalog.product-unit', '44444444-4444-4444-8444-444444444444');
const guestSubject = { guestEvidenceRef: 'guest-evidence', guestSessionRef: 'guest-session', kind: 'GUEST' };
const purchasingContext = {
  contextVerification: {
    evidence: {
      currentness: { evaluatedAt: operationTime, observedAt: operationTime, validFrom: operationTime, validTo: null },
      ownerRef: 'purchase-context',
      ownerRevisionRef: 'revision-1',
      subjectAuthority: {
        guestEvidenceAuthorityRef: 'guest-evidence-authority',
        guestSessionAuthorityRef: 'guest-session-authority',
        kind: 'GUEST',
        subject: guestSubject,
        subjectAuthorityRevisionRef: 'guest-revision-1',
      },
      verificationRef: 'verification-1',
      verifiedScope: { channelId: 'b2c', legalEntityId: 'seller', marketId: 'cz', tenantId },
    },
    outcome: 'PURCHASE_CONTEXT_VERIFIED',
    request: {
      actor: { kind: 'GUEST' },
      operationTime,
      purchasingContext: {
        channelId: 'b2c',
        contextRef: 'purchase-context',
        contextRevision: 'revision-1',
        marketId: 'cz',
        sellingLegalEntityId: 'seller',
      },
      subject: guestSubject,
      tenantId,
    },
  },
};
const input = {
  purchasingContext,
  quantity: { amount: '2.00', unitRef },
  selection: { productRef, variantRef },
};
const decode = Schema.decodeUnknownSync(AvailabilitySubjectSchema, { onExcessProperty: 'error' });

describe('Availability exact subject', () => {
  it('retains exact decimal quantity and Catalog identity without converting or substituting', () => {
    expect(decode(input)).toEqual(input);
  });

  it('rejects Product-only, SKU-only and Stock Item shortcuts', () => {
    for (const selection of [{ productRef }, { sku: 'SHOE-43' }, { stockItemId: 'stock-item' }]) {
      expect(() => decode({ ...input, selection })).toThrow();
    }
  });

  it('requires positive exact decimal quantity and a same-Tenant Catalog Unit', () => {
    for (const amount of ['0', '0.000', '-2', '2e3', 'NaN']) {
      expect(() => decode({ ...input, quantity: { amount, unitRef } })).toThrow();
    }
    expect(() => decode({ ...input, quantity: { amount: '2', unitRef: productRef } })).toThrow();
    expect(() =>
      decode({ ...input, quantity: { amount: '2', unitRef: { ...unitRef, resourceType: 'commerce.catalog.unit' } } }),
    ).toThrow();
    expect(() =>
      decode({ ...input, quantity: { amount: '2', unitRef: { ...unitRef, moduleId: 'foreign.catalog' } } }),
    ).toThrow();
    expect(() =>
      decode({
        ...input,
        quantity: { amount: '2', unitRef: { ...unitRef, tenantId: foreignTenantId } },
      }),
    ).toThrow();
  });

  it('rejects foreign Tenant and unverified or mismatched purchasing contexts', () => {
    const { contextVerification } = purchasingContext;
    expect(() =>
      decode({
        ...input,
        purchasingContext: { contextVerification: { ...contextVerification, outcome: 'PURCHASE_CONTEXT_STALE' } },
      }),
    ).toThrow();
    expect(() =>
      decode({
        ...input,
        purchasingContext: {
          contextVerification: {
            ...contextVerification,
            request: { ...contextVerification.request, tenantId: foreignTenantId },
          },
        },
      }),
    ).toThrow();
    expect(() =>
      decode({
        ...input,
        purchasingContext: {
          contextVerification: {
            ...contextVerification,
            evidence: { ...contextVerification.evidence, ownerRevisionRef: 'other-revision' },
          },
        },
      }),
    ).toThrow();
  });

  it('retains configuration, package and Set revisions as material exact Selection meaning', () => {
    const packageRef = ref('commerce.catalog.package-definition', '55555555-5555-4555-8555-555555555555');
    const configurationRef = ref('commerce.catalog.configuration-definition', '66666666-6666-4666-8666-666666666666');
    const compositionRef = ref('commerce.catalog.set-composition', '77777777-7777-4777-8777-777777777777');
    const selection = {
      ...input.selection,
      configuration: {
        choices: [{ choiceKey: 'size', value: '43' }],
        definition: { resourceRef: configurationRef, revision: 1 },
        productRef,
        variantRef,
      },
      packageOption: { contentRevision: { resourceRef: packageRef, revision: 2 }, optionRef: packageRef },
      setComposition: { resourceRef: compositionRef, revision: 3 },
    };
    const exact = decode({ ...input, selection });
    expect(exact.selection).toEqual(selection);
    expect(
      sameAvailabilitySubject(
        exact,
        decode({
          ...input,
          selection: {
            ...selection,
            setComposition: { resourceRef: compositionRef, revision: 4 },
          },
        }),
      ),
    ).toBe(false);
  });

  it('distinguishes changed quantity, unit and context without rewriting historical subjects', () => {
    const historical = decode(input);
    for (const quantity of [
      { amount: '1.00', unitRef },
      { amount: '2.0', unitRef },
      { amount: '2.00', unitRef: { ...unitRef, resourceId: '88888888-8888-4888-8888-888888888888' } },
    ]) {
      expect(sameAvailabilitySubject(historical, decode({ ...input, quantity }))).toBe(false);
    }
    const changed = decode({
      ...input,
      purchasingContext: {
        ...purchasingContext,
        dimensions: { ownerRef: 'purchase-context', ownerRevisionRef: 'revision-1', storefrontRef: 'other-storefront' },
      },
    });
    expect(sameAvailabilitySubject(historical, changed)).toBe(false);
    expect(historical).toEqual(input);
    expect(historical).not.toHaveProperty('reservation');
    expect(historical).not.toHaveProperty('confirmation');
    expect(historical).not.toHaveProperty('acceptedOrder');
  });
});
