import { createActionCollector, getActionHandler } from '@app/core-runtime/testing/actions';
import { layer as nodeCryptoLayer } from '@effect/platform-node/NodeCrypto';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { AssignCounterpartyPriceGroupPayloadSchema } from '../../shared/actions/assign-counterparty-price-group.ts';
import { AssignCustomerPriceGroupPayloadSchema } from '../../shared/actions/assign-customer-price-group.ts';
import {
  OrganizationPriceGroupAssignmentPayloadSchema,
  OrganizationPriceGroupAssignmentResultSchema,
} from '../../shared/domain/organization-price-assignment.ts';
import { CustomerPriceGroupSourceRejected } from '../../shared/domain/price-group-errors.ts';
import { assignCounterpartyPriceGroupAction } from '../../src/actions/assign-counterparty-price-group.action.ts';
import type { AssignCounterpartyPriceGroupServices } from '../../src/actions/assign-counterparty-price-group.action.ts';
import { customerPriceGroupAssignmentReadRead } from '../../src/api/customer-price-group-assignment-read.read.ts';
import { customerPriceGroupAssignmentReceiptRead } from '../../src/api/customer-price-group-assignment-receipt.read.ts';

const tenantId = 'c1131000-0000-4000-8000-000000000001';
const profile = {
  kind: 'COUNTERPARTY',
  moduleId: 'commerce.customer-context',
  resourceId: 'company-profile',
  resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
  tenantId,
} as const;
const counterpartyRef = {
  moduleId: 'party.registry',
  resourceId: 'company-counterparty',
  resourceType: 'party.registry.counterparty',
  tenantId,
} as const;
const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog',
  resourceId: 'price-group',
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId,
} as const;
const assignmentRef = {
  moduleId: 'commerce.customer-context',
  resourceId: 'assignment',
  resourceType: 'commerce.customer-context.customer-price-group-assignment',
  tenantId,
} as const;
const source = {
  effectId: 'assignment-effect',
  issuer: 'INTERNAL_CONTRACT',
  mappingRevision: 'mapping-1',
  namespace: 'companies',
  occurrenceId: 'occurrence-1',
  order: 1,
  recordId: 'company-1',
  recordType: 'ORGANIZATION',
  revision: 'source-1',
  route: { id: 'companies-import', revision: 'route-1' },
};
const payload = Schema.decodeUnknownSync(OrganizationPriceGroupAssignmentPayloadSchema)({
  counterpartyRef,
  effectiveFrom: '2027-01-01T00:00:00.000Z',
  expectedProfileRevision: 1,
  priceGroupRef,
  processingKind: 'ORGANIZATION_BUSINESS',
  profile,
  source,
});
const scope = {
  authContextRef: 'job:assignment:run:projection-unit',
  authMethod: 'system' as const,
  correlationId: 'organization-assignment',
  legalEntityId: 'c1131000-0000-4000-8000-000000000002',
  principalId: 'c1131000-0000-4000-8000-000000000003',
  tenantId,
};
const recordedAt = '2026-11-07T00:00:00.000Z';
const compatibility = {
  catalogRevision: 1,
  definitionEffectivePeriod: { effectiveFrom: recordedAt, effectiveTo: null },
  definitionRevisionId: 'c1131000-0000-4000-8000-000000000005',
  definitionRevisionNumber: 1,
  meaningFingerprint: 'a'.repeat(64),
  priceGroupRef,
  requiredContract: { contractId: 'commerce.customer-price-group-assignment.v1', version: 1 },
  trustedOperationAt: recordedAt,
  verifiedAt: recordedAt,
};

it('limits the machine recovery carrier to the governed minimal receipt', () => {
  expect(customerPriceGroupAssignmentReadRead.descriptor.accessWorkload).toBeUndefined();
  expect(customerPriceGroupAssignmentReceiptRead.descriptor.accessWorkload?.workloads).toEqual([
    'commerce.customer-context.source-read',
  ]);
});

it('requires the explicit company intent and refuses free text or a Retail target', () => {
  expect(Schema.is(AssignCounterpartyPriceGroupPayloadSchema)(payload)).toBe(true);
  expect(Schema.is(AssignCounterpartyPriceGroupPayloadSchema)({ ...payload, reason: 'A personal note' })).toBe(false);
  expect(Schema.is(AssignCounterpartyPriceGroupPayloadSchema)({ ...payload, reason: null })).toBe(false);
  const { source: _source, ...withoutSource } = payload;
  expect(Schema.is(AssignCounterpartyPriceGroupPayloadSchema)(withoutSource)).toBe(false);
  const retail = { ...profile, kind: 'RETAIL', resourceType: 'commerce.customer-context.retail-customer-profile' };
  expect(
    Schema.is(AssignCustomerPriceGroupPayloadSchema)({ ...payload, profile: retail, reason: 'Personal reason' }),
  ).toBe(false);
  const { processingKind: _classification, ...personal } = payload;
  expect(Schema.is(AssignCounterpartyPriceGroupPayloadSchema)({ ...personal, reason: 'Existing personal path' })).toBe(
    true,
  );
  expect(Schema.is(AssignCounterpartyPriceGroupPayloadSchema)(personal)).toBe(false);
});

const servicesFor = (changed: boolean, denied = false) => {
  let writes = 0;
  let receipts = 0;
  let nativeReason: string | null = null;
  let organizationRoutine = false;
  const services: AssignCounterpartyPriceGroupServices = {
    captureAssignmentReceipt: () =>
      Effect.sync(() => {
        receipts += 1;
      }),
    catalog: { resolveCurrent: () => Effect.succeed({ _tag: 'USABLE', compatibility, priceGroupRef }) },
    now: Effect.succeed(recordedAt),
    profileValidation: {
      inspect: () => Effect.succeed({ _tag: 'CURRENT', counterpartyRef, revision: 1, state: 'ACTIVE' }),
    },
    store: {
      assign: (input) => {
        writes += 1;
        nativeReason = input.reason;
        organizationRoutine = input.organizationBusiness === true;
        return Effect.succeed({
          _tag: 'assigned',
          assignment: {
            assignmentRef,
            compatibility,
            effectiveFrom: payload.effectiveFrom,
            effectiveTo: null,
            priceGroupRef,
            profile,
            reason: 'Legacy private text must never enter the company result or event',
            recordedAt,
            revision: 1,
            state: 'ACTIVE',
          },
          changed,
          replacedAssignmentRef: null,
        });
      },
      list: () => Effect.die('Unexpected list'),
      migrate: () => Effect.die('Unexpected migration'),
      remove: () => Effect.die('Unexpected removal'),
      resolve: () => Effect.die('Unexpected resolution'),
    },
    // This unit seam isolates the handler projection. Production uses the current governed Privacy capability.
    validateAssignmentSource: () =>
      denied
        ? Effect.fail(
            new CustomerPriceGroupSourceRejected({
              code: 'customer_price_group_source_privacy_denied',
              reason: 'Current fixture authority revoked',
            }),
          )
        : Effect.void,
  };
  return { observed: () => ({ nativeReason, organizationRoutine, receipts, writes }), services };
};

it.effect('projects the first result and the separate company event and preserves no-change event suppression', () =>
  Effect.gen(function* safeCompanyProjection() {
    for (const changed of [true, false]) {
      const fixture = servicesFor(changed);
      const { descriptor } = assignCounterpartyPriceGroupAction;
      const collector = createActionCollector(
        descriptor.domainEvents,
        'commerce.customer-context',
        descriptor.accessEvidencePolicy,
        descriptor.auditEvidenceSchema,
      );
      const result = yield* getActionHandler(assignCounterpartyPriceGroupAction)(payload, {
        actionInvocationId: 'c1131000-0000-4000-8000-000000000004',
        ...collector,
        compositionRevision: 'a'.repeat(64),
        scope,
        services: fixture.services,
      });
      expect(Schema.is(OrganizationPriceGroupAssignmentResultSchema)(result)).toBe(true);
      expect(result).not.toHaveProperty('assignment.reason');
      expect(result).not.toHaveProperty('assignment.compatibility');
      expect(fixture.observed()).toEqual({ nativeReason: null, organizationRoutine: true, receipts: 1, writes: 1 });
      const evidence = collector.snapshot();
      expect(evidence.domainEvents).toHaveLength(changed ? 1 : 0);
      expect(evidence.outboxMessages).toHaveLength(changed ? 1 : 0);
      expect(JSON.stringify(evidence)).not.toContain('Legacy private text');
      expect(evidence.domainEvents.map((event) => event.eventType)).toEqual(
        changed ? ['commerce.customer-context.organization-counterparty-price-group-assigned.v1'] : [],
      );
    }
  }).pipe(Effect.provide(nodeCryptoLayer)),
);

it.effect('stops before catalog writes, receipts and events when current company authority is revoked', () =>
  Effect.gen(function* deniedCompanyAssignment() {
    const fixture = servicesFor(true, true);
    const { descriptor } = assignCounterpartyPriceGroupAction;
    const collector = createActionCollector(
      descriptor.domainEvents,
      'commerce.customer-context',
      descriptor.accessEvidencePolicy,
      descriptor.auditEvidenceSchema,
    );
    const failure = yield* Effect.flip(
      getActionHandler(assignCounterpartyPriceGroupAction)(payload, {
        actionInvocationId: 'c1131000-0000-4000-8000-000000000004',
        ...collector,
        compositionRevision: 'a'.repeat(64),
        scope,
        services: fixture.services,
      }),
    );
    expect(Schema.is(CustomerPriceGroupSourceRejected)(failure)).toBe(true);
    expect(fixture.observed()).toEqual({ nativeReason: null, organizationRoutine: false, receipts: 0, writes: 0 });
    expect(collector.snapshot().domainEvents).toHaveLength(0);
    expect(collector.snapshot().outboxMessages).toHaveLength(0);
  }).pipe(Effect.provide(nodeCryptoLayer)),
);
