import type { OperationalScope } from '@app/core-runtime';
import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CommitOrderInputSchema } from '../../shared/domain/order-commitment.ts';
import { commitOrderAction } from '../../src/actions/commit-order.action.ts';
import { frozenPurchaseValueAccessAmount } from '../../src/services/purchase-value-amount.ts';
import { purchaseValueMatchesFrozenBundle } from '../../src/services/order-commitment-persistence.ts';

const tenantId = '40000000-0000-4000-8000-000000000001';
const scope = {
  authContextRef: 'commit-order-amount-test',
  authMethod: 'session',
  correlationId: 'commit-order-amount-test',
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId,
} satisfies OperationalScope;

/**
 * One decoded commit command (O91): the owner-verified frozen purchase value travels in the payload,
 * so the gate has a governed amount before admission. The handler re-checks the same value against
 * the stored Bundle in the same transaction before anything is written.
 */
const commitPayload = (amount: string, currency = 'CZK', sourceRevision = 'cart-1') =>
  Schema.decodeSync(CommitOrderInputSchema)({
    binding: {
      attemptRef: {
        moduleId: 'commerce.order',
        resourceId: 'attempt',
        resourceType: 'commerce.order.commitment-attempt',
        tenantId,
      },
      bundleHash: 'a'.repeat(64),
      bundleRef: {
        moduleId: 'commerce.order',
        resourceId: 'bundle',
        resourceType: 'commerce.order.acceptance-bundle',
        tenantId,
      },
      bundleVersion: 'order-acceptance-bundle.v1',
    },
    expectedRevision: 1,
    purchaseValue: {
      monetaryAmount: { amount, currency },
      roundingRuleRevision: 'round-1',
      sourceRef: 'cart',
      sourceRevision,
    },
    revalidationRef: {
      moduleId: 'commerce.customer-context',
      resourceId: 'revalidation',
      resourceType: 'commerce.customer-context.approval-revalidation',
      tenantId,
    },
  });

describe('commerce.order commit governed amount (O91)', () => {
  it('declares the owner-verified frozen total as the governed amount, never a client total (O18, O91)', () => {
    const declaration = commitOrderAction.descriptor.accessDeclaration;
    expect(declaration?.amountInput).toBe('derived.purchaseValue');
    expect(commitOrderAction.descriptor.accessAmount).toBeDefined();
  });

  it('derives a below-ceiling amount and an above-ceiling amount from the frozen value (O18)', () => {
    const resolve = commitOrderAction.descriptor.accessAmount;
    if (resolve === undefined) {
      throw new Error('The commit Action declares its frozen purchase-value resolver');
    }
    const below = resolve(commitPayload('999.99'), scope);
    const above = resolve(commitPayload('1000.01'), scope);
    // A CZK ceiling of 100_000 minor units admits the below value and refuses the above one.
    expect(below).toEqual({ currency: 'CZK', minor: 99_999 });
    expect(above).toEqual({ currency: 'CZK', minor: 100_001 });
    expect(below.minor).toBeLessThan(100_000);
    expect(above.minor).toBeGreaterThan(100_000);
  });

  it('matches the payload value against the stored Bundle exactly (O91)', () => {
    const frozen = commitPayload('1000').purchaseValue;
    // The honest payload is the stored value: the check passes.
    expect(purchaseValueMatchesFrozenBundle(frozen, frozen)).toBe(true);
    expect(purchaseValueMatchesFrozenBundle(frozen, commitPayload('1000').purchaseValue)).toBe(true);
  });

  it('refuses a forged lower value, a different currency and a stale source (O91)', () => {
    const frozen = commitPayload('1000').purchaseValue;
    // A forged lower total would slip beneath a ceiling, so it is refused.
    expect(purchaseValueMatchesFrozenBundle(frozen, commitPayload('1').purchaseValue)).toBe(false);
    // A different currency is not the stored purchase.
    expect(purchaseValueMatchesFrozenBundle(frozen, commitPayload('1000', 'EUR').purchaseValue)).toBe(false);
    // A stale retained source (a different revision) is refused even with the same amount.
    expect(purchaseValueMatchesFrozenBundle(frozen, commitPayload('1000', 'CZK', 'cart-2').purchaseValue)).toBe(false);
  });

  it('is the same derivation the gate reads, so the check cannot drift from the admitted amount (O91)', () => {
    const payload = commitPayload('1000.005');
    const resolve = commitOrderAction.descriptor.accessAmount;
    expect(resolve?.(payload, scope)).toEqual(frozenPurchaseValueAccessAmount(payload.purchaseValue));
  });
});
