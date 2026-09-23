import type { ActionHandlerContext } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { GovernProductAttributeApplicabilityPayloadSchema } from '../../shared/actions/govern-product-attribute-applicability.ts';
import {
  governProductAttributeApplicabilityAction,
  handleGovernProductAttributeApplicability,
} from '../../src/actions/govern-product-attribute-applicability.action.ts';
import type { AttributeApplicabilityPersistence } from '../../src/persistence/attribute-applicability-persistence.ts';
import { AttributeApplicabilityConflict } from '../../src/persistence/attribute-applicability-persistence.ts';
import { CatalogPersistenceUnavailable } from '../../src/persistence/errors.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const attributeDefinitionRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.attribute-definition',
  tenantId,
} as const;
const payload = Schema.decodeUnknownSync(GovernProductAttributeApplicabilityPayloadSchema)({
  attributeDefinitionRef,
  evidenceRefs: ['type-rule-review-1'],
  expectedRevision: null,
  impactConfirmation: {
    affectedOpenSelectionIds: ['cart-selection-1'],
    expectedPopulationRevisionToken: 'cart-population-1',
    remediationEvidenceRefs: ['applicability-remediation-1'],
  },
  productLevel: true,
  productRef,
  reason: 'Allow this property on the Product',
  variantLevel: false,
});
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:attribute-applicability:run:1',
    authMethod: 'system',
    principalId: '44444444-4444-4444-8444-444444444444',
    tenantId,
  }),
  correlationId: 'attribute-applicability-action-test',
};

const contextWith = (change: AttributeApplicabilityPersistence['change']) => {
  const context: ActionHandlerContext<Readonly<Record<string, never>>, AttributeApplicabilityPersistence> = {
    actionInvocationId: '55555555-5555-4555-8555-555555555555',
    addDomainEvent: () => Effect.succeed(Object.create(null)),
    addOutboxMessage: () => Effect.void,
    recordAuditEvidence: () => Effect.void,
    recordDataAccess: () => Effect.void,
    scope,
    services: { change },
  };
  return context;
};

describe('govern Product Attribute applicability Action', () => {
  it('requires typed refs, a reason, and an exact or absent revision', () => {
    expect(Schema.is(GovernProductAttributeApplicabilityPayloadSchema)(payload)).toBe(true);
    expect(Schema.is(GovernProductAttributeApplicabilityPayloadSchema)({ ...payload, expectedRevision: 0 })).toBe(
      false,
    );
    expect(Schema.is(GovernProductAttributeApplicabilityPayloadSchema)({ ...payload, reason: '' })).toBe(false);
    expect(
      Schema.is(GovernProductAttributeApplicabilityPayloadSchema)({
        ...payload,
        impactConfirmation: { ...payload.impactConfirmation, remediationEvidenceRefs: [] },
      }),
    ).toBe(false);
    expect(
      Schema.is(GovernProductAttributeApplicabilityPayloadSchema)({
        ...payload,
        impactConfirmation: {
          ...payload.impactConfirmation,
          affectedOpenSelectionIds: ['cart-selection-1', 'cart-selection-1'],
        },
      }),
    ).toBe(false);
    expect(
      Schema.is(GovernProductAttributeApplicabilityPayloadSchema)({
        ...payload,
        productRef: { ...productRef, moduleId: 'other' },
      }),
    ).toBe(false);
  });

  it.effect('passes trusted invocation and principal to the scoped owner service', () =>
    Effect.gen(function* handoff() {
      const context = contextWith((input) =>
        Effect.sync(() => {
          expect(input).toMatchObject({
            actionInvocationId: context.actionInvocationId,
            attributeDefinitionRef,
            evidenceRefs: payload.evidenceRefs,
            expectedRevision: null,
            impactConfirmation: payload.impactConfirmation,
            principalId: scope.principalId,
            productLevel: true,
            productRef,
            reason: payload.reason,
            variantLevel: false,
          });
          return { productLevel: true, revision: 1, variantLevel: false };
        }),
      );
      expect(yield* handleGovernProductAttributeApplicability(payload, context)).toMatchObject({
        attributeDefinitionRef,
        productRef,
        revision: 1,
      });
    }),
  );

  it('declares conflict and unavailable failures under the governed Action lifecycle', () => {
    const { descriptor } = governProductAttributeApplicabilityAction;
    expect(descriptor.entrypoint.authorization).toEqual({ kind: 'action_execution', provisioning: 'explicit' });
    expect(descriptor.idempotency).toBe('required');
    expect(descriptor.legalEntityScope).toBe('forbidden');
    expect(
      Schema.is(descriptor.domainErrorSchema)(
        new AttributeApplicabilityConflict({
          code: 'attribute_applicability_conflict',
          conflict: 'SELECTION_IMPACT',
          reason: 'Proof unavailable',
        }),
      ),
    ).toBe(true);
    expect(
      Schema.is(descriptor.domainErrorSchema)(
        new CatalogPersistenceUnavailable({
          code: 'catalog_persistence_unavailable',
          reason: 'Unavailable',
        }),
      ),
    ).toBe(true);
  });
});
