import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  DecideProductTypeUnnecessaryPayloadSchema,
  DecideProductTypeUnnecessaryResultSchema,
  decideProductTypeUnnecessaryAction,
} from '../../src/actions/decide-product-type-unnecessary.action.ts';
import { ProductTypeUntypedDecisionRejected } from '../../src/persistence/product-type-untyped-decision-persistence.ts';

const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product',
  tenantId: '11111111-1111-4111-8111-111111111111',
} as const;
const payload = {
  decisionState: 'CONFIRMED',
  evidenceRefs: ['catalog-review:123'],
  expectedAxisRevision: 0,
  expectedDecisionRevision: 0,
  expectedProductRevision: 1,
  expectedValueRevisionTokens: [],
  expectedVariantRevisionTokens: [],
  productRef,
  reason: 'The Current simple product form needs neither structured attributes nor axes',
  structuredAttributesRequired: false,
  variantAxesRequired: false,
} as const;

describe('Decide Product Type unnecessary Action contract', () => {
  it('requires explicit negative need and a complete caller revision basis', () => {
    const decode = Schema.decodeUnknownSync(DecideProductTypeUnnecessaryPayloadSchema);
    expect(decode(payload)).toMatchObject(payload);
    expect(() => decode({ ...payload, structuredAttributesRequired: true })).toThrow();
    expect(() => decode({ ...payload, variantAxesRequired: true })).toThrow();
    expect(() => decode({ ...payload, expectedDecisionRevision: -1 })).toThrow();
    const { expectedVariantRevisionTokens: _omitted, ...withoutVariantBasis } = payload;
    expect(() => decode(withoutVariantBasis)).toThrow();
    expect(() => decode({ ...payload, evidenceRefs: [] })).toThrow();
  });

  it('records only a partial decision outcome, not overall Catalog readiness', () => {
    const result = Schema.decodeUnknownSync(DecideProductTypeUnnecessaryResultSchema)({
      decisionRevision: 1,
      decisionState: 'CONFIRMED',
      productRef,
    });
    expect(result.decisionRevision).toBe(1);
    expect('catalogReady' in result).toBe(false);
  });

  it('uses the generated authorized tenant Action and a typed domain rejection', () => {
    expect(decideProductTypeUnnecessaryAction.descriptor.entrypoint.authorization).toEqual({
      kind: 'action_execution',
      provisioning: 'explicit',
    });
    expect(decideProductTypeUnnecessaryAction.descriptor.legalEntityScope).toBe('forbidden');
    expect(decideProductTypeUnnecessaryAction.descriptor.idempotency).toBe('required');
    expect(
      Schema.is(decideProductTypeUnnecessaryAction.descriptor.domainErrorSchema)(
        new ProductTypeUntypedDecisionRejected({
          code: 'product_type_untyped_decision_rejected',
          reason: 'Revision is stale',
        }),
      ),
    ).toBe(true);
  });
});
