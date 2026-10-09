import { expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import { AssortmentBindingAudienceSchema } from '../../shared/actions/policy-administration.ts';
import {
  AssortmentApplicabilityBindingRefSchema,
  AssortmentClosedBoundaryRefSchema,
  AssortmentCommercialScopeSchema,
  AssortmentOwnerResourceRefSchema,
  AssortmentRuleRevisionReferenceSchema,
  AssortmentStableRuleRefSchema,
} from '../../shared/domain/decision-contracts.ts';
import { OutboxPayloadSchema as BindingCreatedPayloadSchema } from '../../shared/outbox/commerce-assortment-binding-created-v1.ts';
import { OutboxPayloadSchema as BindingEndedPayloadSchema } from '../../shared/outbox/commerce-assortment-binding-ended-v1.ts';
import { OutboxPayloadSchema as BindingReplacedPayloadSchema } from '../../shared/outbox/commerce-assortment-binding-replaced-v1.ts';
import { OutboxPayloadSchema as BoundaryCreatedPayloadSchema } from '../../shared/outbox/commerce-assortment-boundary-created-v1.ts';
import { OutboxPayloadSchema as BoundaryEndedPayloadSchema } from '../../shared/outbox/commerce-assortment-boundary-ended-v1.ts';
import { OutboxPayloadSchema as BoundaryReplacedPayloadSchema } from '../../shared/outbox/commerce-assortment-boundary-replaced-v1.ts';
import { OutboxPayloadSchema as RuleCreatedPayloadSchema } from '../../shared/outbox/commerce-assortment-rule-created-v1.ts';
import { OutboxPayloadSchema as RuleRetiredPayloadSchema } from '../../shared/outbox/commerce-assortment-rule-retired-v1.ts';
import { OutboxPayloadSchema as RuleRevisionCreatedPayloadSchema } from '../../shared/outbox/commerce-assortment-rule-revision-created-v1.ts';

const tenantId = '018f8b4e-35a2-7b51-8d56-91a4f37d6a11';
const otherTenantId = '018f8b4e-35a2-7b51-8d56-91a4f37d6a22';

const ref = (moduleId: string, resourceType: string, resourceId: string, tenant = tenantId) =>
  Schema.decodeUnknownSync(AssortmentOwnerResourceRefSchema)({ moduleId, resourceId, resourceType, tenantId: tenant });

const stableRuleRef = Schema.decodeUnknownSync(AssortmentStableRuleRefSchema)({
  moduleId: 'commerce.assortment',
  resourceId: 'rule-1',
  resourceType: 'commerce.assortment.stable-rule',
  tenantId,
});
const ruleRevisionRef = Schema.decodeUnknownSync(AssortmentRuleRevisionReferenceSchema)({
  ownerModuleId: 'commerce.assortment',
  revision: 'revision-1',
  sourceRef: ref('commerce.assortment', 'commerce.assortment.rule-revision', 'revision-1'),
});
const bindingRef = Schema.decodeUnknownSync(AssortmentApplicabilityBindingRefSchema)({
  moduleId: 'commerce.assortment',
  resourceId: 'binding-1',
  resourceType: 'commerce.assortment.applicability-binding',
  tenantId,
});
const boundaryRef = Schema.decodeUnknownSync(AssortmentClosedBoundaryRefSchema)({
  moduleId: 'commerce.assortment',
  resourceId: 'boundary-1',
  resourceType: 'commerce.assortment.closed-assortment-boundary',
  tenantId,
});
const commercialScope = Schema.decodeUnknownSync(AssortmentCommercialScopeSchema)({
  channelRef: ref('commerce.channel', 'commerce.channel', 'web'),
  sellingLegalEntityRef: ref('commerce.legal-entity', 'commerce.legal-entity', 'entity-1'),
});
const audience = Schema.decodeUnknownSync(AssortmentBindingAudienceSchema)({ kind: 'SHARED' });
const selector = { kind: 'PRODUCT' as const, productRef: ref('catalog.owner', 'catalog.product', 'product-1') };
const purchasingSubject = {
  kind: 'RETAIL_CUSTOMER_PROFILE' as const,
  profileRef: ref('commerce.customer-context', 'commerce.customer-context.retail-customer-profile', 'profile-1'),
};
const admissionSet = { entries: [selector] };

const decodeStrict = <SchemaType extends Schema.ConstraintDecoder<unknown>>(schema: SchemaType, value: Schema.Json) =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' })(value);

it('emits exact owner-linked invalidation slices for Rule changes', () => {
  const created = decodeStrict(RuleCreatedPayloadSchema, {
    change: 'RULE_CREATED',
    kind: 'ASSORTMENT_DISCOVERY_PROJECTION_INVALIDATION',
    slice: { decisionPurpose: 'VISIBILITY', ruleRevisionRef, selector, stableRuleRef },
  });
  expect(created.slice.stableRuleRef.resourceId).toBe('rule-1');

  const revision = decodeStrict(RuleRevisionCreatedPayloadSchema, {
    change: 'RULE_REVISION_CREATED',
    kind: 'ASSORTMENT_DISCOVERY_PROJECTION_INVALIDATION',
    slice: { decisionPurpose: 'PURCHASE', ruleRevisionRef, selector, stableRuleRef },
  });
  expect(revision.slice.ruleRevisionRef.revision).toBe('revision-1');

  const retired = decodeStrict(RuleRetiredPayloadSchema, {
    change: 'RULE_RETIRED',
    kind: 'ASSORTMENT_DISCOVERY_PROJECTION_INVALIDATION',
    slice: { stableRuleRef },
  });
  expect(retired.slice.stableRuleRef.resourceId).toBe('rule-1');
});

it('emits exact owner-linked invalidation slices for Binding changes', () => {
  const created = decodeStrict(BindingCreatedPayloadSchema, {
    change: 'BINDING_CREATED',
    kind: 'ASSORTMENT_DISCOVERY_PROJECTION_INVALIDATION',
    slice: { applicabilityBindingRef: bindingRef, audience, commercialScope, ruleRevisionRef },
  });
  expect(created.slice.applicabilityBindingRef.resourceId).toBe('binding-1');

  const ended = decodeStrict(BindingEndedPayloadSchema, {
    change: 'BINDING_ENDED',
    kind: 'ASSORTMENT_DISCOVERY_PROJECTION_INVALIDATION',
    slice: { applicabilityBindingRef: bindingRef },
  });
  expect(ended.slice.applicabilityBindingRef.resourceId).toBe('binding-1');

  const replaced = decodeStrict(BindingReplacedPayloadSchema, {
    change: 'BINDING_REPLACED',
    kind: 'ASSORTMENT_DISCOVERY_PROJECTION_INVALIDATION',
    slice: {
      createdBindingRef: { ...bindingRef, resourceId: 'binding-2' },
      endedBindingRef: bindingRef,
      proposedAudience: audience,
      proposedCommercialScope: commercialScope,
      proposedRuleRevisionRef: ruleRevisionRef,
    },
  });
  expect(replaced.slice.createdBindingRef.resourceId).toBe('binding-2');
});

it('rejects cross-tenant slices and outcome or completeness claims', () => {
  expect(() =>
    decodeStrict(BindingCreatedPayloadSchema, {
      change: 'BINDING_CREATED',
      kind: 'ASSORTMENT_DISCOVERY_PROJECTION_INVALIDATION',
      slice: {
        applicabilityBindingRef: bindingRef,
        audience,
        commercialScope: {
          ...commercialScope,
          channelRef: { ...commercialScope.channelRef, tenantId: otherTenantId },
        },
        ruleRevisionRef,
      },
    }),
  ).toThrow();

  expect(() =>
    decodeStrict(RuleRetiredPayloadSchema, {
      change: 'RULE_RETIRED',
      completeness: 'COMPLETE',
      kind: 'ASSORTMENT_DISCOVERY_PROJECTION_INVALIDATION',
      slice: { stableRuleRef },
    }),
  ).toThrow();
  expect(() =>
    decodeStrict(RuleCreatedPayloadSchema, {
      change: 'RULE_CREATED',
      kind: 'ASSORTMENT_DISCOVERY_PROJECTION_INVALIDATION',
      outcome: 'ELIGIBLE',
      slice: { decisionPurpose: 'VISIBILITY', ruleRevisionRef, selector, stableRuleRef },
    }),
  ).toThrow();
});

it('emits exact owner-linked invalidation slices for Boundary changes', () => {
  const created = decodeStrict(BoundaryCreatedPayloadSchema, {
    change: 'BOUNDARY_CREATED',
    kind: 'ASSORTMENT_DISCOVERY_PROJECTION_INVALIDATION',
    slice: {
      admissionSet,
      boundaryRef,
      commercialScope,
      decisionPurpose: 'VISIBILITY',
      subject: purchasingSubject,
    },
  });
  expect(created.slice.boundaryRef.resourceId).toBe('boundary-1');

  const ended = decodeStrict(BoundaryEndedPayloadSchema, {
    change: 'BOUNDARY_ENDED',
    kind: 'ASSORTMENT_DISCOVERY_PROJECTION_INVALIDATION',
    slice: { boundaryRef },
  });
  expect(ended.slice.boundaryRef.resourceId).toBe('boundary-1');

  const replaced = decodeStrict(BoundaryReplacedPayloadSchema, {
    change: 'BOUNDARY_REPLACED',
    kind: 'ASSORTMENT_DISCOVERY_PROJECTION_INVALIDATION',
    slice: {
      createdBoundaryRef: { ...boundaryRef, resourceId: 'boundary-2' },
      endedBoundaryRef: boundaryRef,
      proposedAdmissionSet: admissionSet,
      proposedCommercialScope: commercialScope,
      proposedDecisionPurpose: 'VISIBILITY',
      proposedSubject: purchasingSubject,
    },
  });
  expect(replaced.slice.createdBoundaryRef.resourceId).toBe('boundary-2');
});
