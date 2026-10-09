import type { OperationalScope } from '@app/core-runtime';
import { Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  AssortmentDecisionEvidenceSchema,
  AssortmentVisibilityRequestSchema,
  AssortmentPurchaseRequestSchema,
} from '../../shared/domain/decision-contracts.ts';
import {
  AssortmentConfigurationRequestSchema,
  AssortmentDecisionExplanationRequestSchema,
  AssortmentConfigurationResponseSchema,
} from '../../shared/domain/governed-read-contracts.ts';
import {
  AssortmentPolicyPersistenceUnavailable,
  AssortmentPolicyTargetInvariant,
} from '../../shared/domain/policy-errors.ts';
import {
  assortmentConfigurationReadService,
  configurationPermissionTarget,
} from '../../src/services/governed-configuration-read.service.ts';
import {
  assortmentDecisionExplanationReadService,
  decisionExplanationPermissionTarget,
} from '../../src/services/decision-explanation-read.service.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '30000000-0000-4000-8000-000000000001';
const scope = {
  authContextRef: 'governed-read-test',
  authMethod: 'session',
  correlationId: 'governed-read-test',
  legalEntityId,
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId,
} satisfies OperationalScope;
const ref = (moduleId: string, resourceType: string, resourceId: string, ownerTenant = tenantId) => ({
  moduleId,
  resourceId,
  resourceType,
  tenantId: ownerTenant,
});
const channelRef = ref('commerce.channel', 'commerce.channel.channel', 'channel-1');
const sellingLegalEntityRef = ref('party.registry', 'party.registry.legal-entity', legalEntityId);
const productRef = ref('catalog.owner', 'catalog.owner.product', 'product-1');
const profileRef = ref('commerce.customer-context', 'commerce.customer-context.retail-customer-profile', 'profile-1');
const request = Schema.decodeUnknownSync(AssortmentVisibilityRequestSchema)({
  decisionPurpose: 'VISIBILITY',
  productRef,
  subject: { kind: 'IDENTIFIED', subject: { kind: 'RETAIL_CUSTOMER_PROFILE', profileRef } },
  trustedContext: {
    channelRef,
    operationTime: '2026-09-23T09:00:00.000Z',
    sellingLegalEntityRef,
    tenantId,
  },
});
const evidence = Schema.decodeUnknownSync(AssortmentDecisionEvidenceSchema)({
  factCurrentness: [],
  operationTime: '2026-09-23T09:00:00.000Z',
  setCompleteness: [],
  subject: request.subject,
  target: { kind: 'PRODUCT', productRef },
  trustedContext: {
    channelRef,
    operationTime: '2026-09-23T09:00:00.000Z',
    sellingLegalEntityRef,
    tenantId,
  },
});
const evidenceRef = ref('commerce.assortment', 'commerce.assortment.decision-evidence', 'evidence-1');
const explanationRequest = Schema.decodeUnknownSync(AssortmentDecisionExplanationRequestSchema)({
  evidenceRef: { evidenceRef, ownerModuleId: 'commerce.assortment' },
  request: {
    decisionPurpose: 'VISIBILITY',
    productRef,
    subject: { kind: 'IDENTIFIED', subject: { kind: 'RETAIL_CUSTOMER_PROFILE', profileRef } },
    trustedContext: {
      channelRef,
      operationTime: '2026-09-23T09:00:00.000Z',
      sellingLegalEntityRef,
      tenantId,
    },
  },
});

it.effect('requires one exact owner resource and trusted tenant for configuration reads', () =>
  Effect.gen(function* exactConfigurationResource() {
    const configRequest = Schema.decodeUnknownSync(AssortmentConfigurationRequestSchema)({
      resource: ref('commerce.assortment', 'commerce.assortment.rule-revision', 'revision-1'),
    });
    expect(configRequest.resource.resourceType).toStrictEqual('commerce.assortment.rule-revision');
    expect(
      Schema.is(AssortmentConfigurationRequestSchema)({
        resource: ref('commerce.assortment', 'commerce.assortment.admission-set-entry', 'entry-1'),
      }),
    ).toStrictEqual(false);
    const service = assortmentConfigurationReadService(
      {
        resolve: () =>
          Effect.succeed(
            Schema.decodeUnknownSync(AssortmentConfigurationResponseSchema)({
              configuration: {
                kind: 'REVISION' as const,
                value: {
                  createdAt: '2026-09-23T09:00:00.000Z',
                  decisionPurpose: 'PURCHASE' as const,
                  effect: 'ALLOW' as const,
                  meaningFingerprint: 'a'.repeat(64),
                  revision: {
                    ownerModuleId: 'commerce.assortment',
                    revision: '1',
                    sourceRef: ref('commerce.assortment', 'commerce.assortment.rule-revision', 'revision-1'),
                  },
                  selector: { kind: 'ALL' as const },
                },
              },
            }),
          ),
      },
      scope,
    );
    const result = yield* service.read(configRequest);
    expect(result.configuration.kind).toStrictEqual('REVISION');
    expect(configurationPermissionTarget(configRequest, scope).permission).toStrictEqual(
      'assortment.configuration.read',
    );
    const foreignRequest = Schema.decodeUnknownSync(AssortmentConfigurationRequestSchema)({
      resource: ref(
        'commerce.assortment',
        'commerce.assortment.rule-revision',
        'revision-foreign',
        '90000000-0000-4000-8000-000000000009',
      ),
    });
    const foreignError = yield* Effect.flip(service.read(foreignRequest));
    expect(Schema.is(AssortmentPolicyPersistenceUnavailable)(foreignError)).toStrictEqual(true);
  }),
);

it.effect('resolves protected explanation only from owner-loaded exact evidence', () =>
  Effect.gen(function* exactEvidence() {
    const service = assortmentDecisionExplanationReadService(scope, () =>
      Effect.succeed({ evidence, outcome: 'ELIGIBLE' as const, request }),
    );
    const result = yield* service.explain(explanationRequest);
    expect(result.outcome).toStrictEqual('ELIGIBLE');
    expect(result.evidence.target).toStrictEqual(evidence.target);
  }),
);

it.effect('rejects forged, cross-tenant, and wrong-request explanation inputs', () =>
  Effect.gen(function* rejectsForgedEvidence() {
    const service = assortmentDecisionExplanationReadService(scope, () =>
      Effect.succeed({ evidence, outcome: 'ELIGIBLE' as const, request }),
    );
    const foreignReference = Schema.decodeUnknownSync(AssortmentDecisionExplanationRequestSchema)({
      evidenceRef: {
        evidenceRef: ref(
          'commerce.assortment',
          'commerce.assortment.decision-evidence',
          'evidence-foreign',
          '90000000-0000-4000-8000-000000000009',
        ),
        ownerModuleId: 'commerce.assortment',
      },
      request: {
        decisionPurpose: 'VISIBILITY',
        productRef,
        subject: { kind: 'IDENTIFIED', subject: { kind: 'RETAIL_CUSTOMER_PROFILE', profileRef } },
        trustedContext: {
          channelRef,
          operationTime: '2026-09-23T09:00:00.000Z',
          sellingLegalEntityRef,
          tenantId,
        },
      },
    });
    const foreignError = yield* Effect.flip(service.explain(foreignReference));
    expect(Schema.is(AssortmentPolicyTargetInvariant)(foreignError)).toStrictEqual(true);
    const wrongRequest = Schema.decodeUnknownSync(AssortmentDecisionExplanationRequestSchema)({
      evidenceRef: { evidenceRef, ownerModuleId: 'commerce.assortment' },
      request: {
        decisionPurpose: 'VISIBILITY',
        productRef: ref('catalog.owner', 'catalog.owner.product', 'product-2'),
        subject: { kind: 'IDENTIFIED', subject: { kind: 'RETAIL_CUSTOMER_PROFILE', profileRef } },
        trustedContext: {
          channelRef,
          operationTime: '2026-09-23T09:00:00.000Z',
          sellingLegalEntityRef,
          tenantId,
        },
      },
    });
    const wrongError = yield* Effect.flip(service.explain(wrongRequest));
    expect(Schema.is(AssortmentPolicyTargetInvariant)(wrongError)).toStrictEqual(true);
  }),
);

it('derives exact decision permission target from trusted request scope', () => {
  const target = decisionExplanationPermissionTarget(request, scope);
  expect(target.permission).toStrictEqual('assortment.decision.explain');
  expect(target.catalogSelection.resourceId).toStrictEqual('product-1');
  expect(target.subject.kind).toStrictEqual('RETAIL_CUSTOMER_PROFILE');
});

it.effect('keeps explanation bound to the stored component role as well as its selection', () =>
  Effect.gen(function* explainsComponentIdentity() {
    const componentRequest = Schema.decodeUnknownSync(AssortmentPurchaseRequestSchema)({
      constituent: {
        catalogSelection: {
          configuration: { kind: 'NONE' },
          productRef,
          variantKind: 'ATOMIC',
          variantRef: ref('catalog.owner', 'catalog.variant', 'component-1'),
        },
        role: 'REQUIRED_COMPONENT',
      },
      decisionPurpose: 'PURCHASE',
      subject: request.subject,
      trustedContext: {
        ...request.trustedContext,
        operationTime: '2026-09-23T09:00:00.000Z',
      },
    });
    const componentEvidence = {
      ...evidence,
      target: { kind: 'CATALOG_SELECTION' as const, selection: componentRequest.constituent.catalogSelection },
    };
    const service = assortmentDecisionExplanationReadService(scope, () =>
      Effect.succeed({
        evidence: componentEvidence,
        outcome: 'ELIGIBLE',
        request: componentRequest,
      }),
    );
    const input = { evidenceRef: explanationRequest.evidenceRef, request: componentRequest };
    expect((yield* service.explain(input)).outcome).toBe('ELIGIBLE');
    const forged = {
      ...input,
      request: { ...componentRequest, constituent: { ...componentRequest.constituent, role: 'TOP_LEVEL' as const } },
    };
    const refused = yield* Effect.exit(service.explain(forged));
    expect(Exit.isFailure(refused)).toBe(true);
  }),
);
