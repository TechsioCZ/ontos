import type { ActionAccessEvidencePolicy } from '@app/core-runtime';
import type { DomainEventContractMap } from '../../../../packages/core-runtime/src/actions/events.ts';
import { PriceGroupCompatibilityDecisionSchema } from '@app/price-group-catalog-contracts';
import type { ValidatePriceGroupCompatibilityRequest } from '@app/price-group-catalog-contracts/validate-price-group-compatibility';
import { Effect, Match, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { getActionHandler } from '../../../../packages/core-runtime/src/actions/definition.ts';
import type {
  CustomerPriceGroupAssignment,
  PriceGroupCompatibilityEvidence,
} from '../../shared/domain/price-group-contracts.ts';
import { CustomerPriceGroupCatalogUnavailable } from '../../shared/domain/price-group-errors.ts';
import { CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT } from '../../shared/domain/price-group-ports.ts';
import { resolveCustomerPriceGroupAt } from '../../shared/domain/price-group-resolution.ts';
import { assignCounterpartyPriceGroupAction } from '../../src/actions/assign-counterparty-price-group.action.ts';
import type { AssignCounterpartyPriceGroupServices } from '../../src/actions/assign-counterparty-price-group.action.ts';
import { assignCustomerPriceGroupAction } from '../../src/actions/assign-customer-price-group.action.ts';
import { migrateCounterpartyPriceGroupAction } from '../../src/actions/migrate-counterparty-price-group.action.ts';
import { migrateCustomerPriceGroupAction } from '../../src/actions/migrate-customer-price-group.action.ts';
import { priceGroupCatalogPort } from '../../src/integrations/price-group-catalog.ts';

const tenantId = '334a0000-0000-4000-8000-000000000001';
const originalCompositionRevision = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const operationAt = '2026-09-23T10:00:00.000Z';
const scheduledAt = '2026-10-01T00:00:00.000Z';
const group = {
  moduleId: 'pricing.price-group-catalog',
  resourceId: '334a0000-0000-4000-8000-000000000002',
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId,
};
const profile = {
  kind: 'RETAIL',
  moduleId: 'commerce.customer-context',
  resourceId: '334a0000-0000-4000-8000-000000000003',
  resourceType: 'commerce.customer-context.retail-customer-profile',
  tenantId,
} as const;
const counterpartyRef = {
  moduleId: 'party.registry',
  resourceId: '334a0000-0000-4000-8000-000000000004',
  resourceType: 'party.registry.counterparty',
  tenantId,
} as const;
const counterpartyProfile = {
  ...profile,
  kind: 'COUNTERPARTY',
  resourceId: '334a0000-0000-4000-8000-000000000005',
  resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
} as const;
const assignmentRef = {
  moduleId: 'commerce.customer-context',
  resourceId: '334a0000-0000-4000-8000-000000000006',
  resourceType: 'commerce.customer-context.customer-price-group-assignment',
  tenantId,
} as const;
const evidence = {
  catalogRevision: 1,
  definitionEffectivePeriod: { effectiveFrom: '2026-08-01T00:00:00.000Z', effectiveTo: null },
  definitionRevisionId: '334a0000-0000-4000-8000-000000000007',
  definitionRevisionNumber: 1,
  meaningFingerprint: 'a'.repeat(64),
  priceGroupRef: group,
  requiredContract: { contractId: CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT, version: 1 },
  trustedOperationAt: '2026-09-01T00:00:00.000Z',
  verifiedAt: '2026-09-01T00:00:01.000Z',
};
const assignment: CustomerPriceGroupAssignment = {
  assignmentRef,
  compatibility: evidence,
  effectiveFrom: '2026-09-01T00:00:00.000Z',
  effectiveTo: null,
  priceGroupRef: group,
  profile,
  reason: 'Original assignment evidence remains historical.',
  recordedAt: '2026-09-01T00:00:01.000Z',
  revision: 1,
  state: 'ACTIVE',
};

it.effect('B1 refreshes compatible definition and retirement fences without rewriting assignment evidence', () =>
  Effect.gen(function* refreshCurrentEvidence() {
    const original = structuredClone(assignment);
    const requests: ValidatePriceGroupCompatibilityRequest[] = [];
    const freshEvidence = {
      ...evidence,
      catalogRevision: 3,
      definitionEffectivePeriod: {
        effectiveFrom: '2026-09-15T00:00:00.000Z',
        effectiveTo: '2026-09-25T00:00:00.000Z',
      },
      definitionRevisionId: '334a0000-0000-4000-8000-000000000008',
      definitionRevisionNumber: 2,
      trustedOperationAt: operationAt,
      verifiedAt: operationAt,
    };
    const catalog = priceGroupCatalogPort('b1-refresh', (request) => {
      requests.push(request);
      return Schema.decodeUnknownEffect(PriceGroupCompatibilityDecisionSchema)({
        evidence: freshEvidence,
        kind: 'USABLE',
      }).pipe(
        Effect.mapError(
          () =>
            new CustomerPriceGroupCatalogUnavailable({
              code: 'customer_price_group_catalog_unavailable',
              reason: 'The regression provider could not produce valid evidence.',
            }),
        ),
      );
    });

    const resolved = yield* resolveCustomerPriceGroupAt(profile, [assignment], operationAt, catalog);
    expect(
      Match.value(resolved).pipe(
        Match.tag('ASSIGNED', ({ compatibility }) => compatibility),
        Match.orElse(() => {}),
      ),
    ).toEqual(freshEvidence);
    expect(requests).toEqual([
      {
        priceGroupRef: group,
        requiredContract: evidence.requiredContract,
        trustedOperationAt: operationAt,
      },
    ]);
    expect(assignment).toEqual(original);
  }),
);

it.effect('B1 resolves a newly incompatible definition as BROKEN rather than stale-evidence unavailability', () =>
  Effect.gen(function* resolveChangedContract() {
    const catalog = priceGroupCatalogPort('b1-incompatible', () =>
      Effect.succeed(
        Schema.decodeUnknownSync(PriceGroupCompatibilityDecisionSchema)({
          evidence: {
            definitionRevisionId: '334a0000-0000-4000-8000-000000000008',
            definitionRevisionNumber: 2,
            evaluatedCatalogRevision: 2,
            meaningFingerprint: evidence.meaningFingerprint,
            priceGroupRef: group,
            requiredContract: evidence.requiredContract,
            trustedOperationAt: operationAt,
            verifiedAt: operationAt,
          },
          kind: 'INCOMPATIBLE',
        }),
      ),
    );
    const resolved = yield* resolveCustomerPriceGroupAt(profile, [assignment], operationAt, catalog);
    expect(
      Match.value(resolved).pipe(
        Match.tag('BROKEN', ({ catalogRevision, reason }) => ({ catalogRevision, reason })),
        Match.orElse(() => {}),
      ),
    ).toEqual({ catalogRevision: 2, reason: 'INCOMPATIBLE' });
  }),
);

it.effect('B1 still fails closed when the owner cannot establish Current compatibility', () =>
  Effect.gen(function* preserveOwnerFailure() {
    const catalog = priceGroupCatalogPort('b1-outage', () =>
      Effect.fail(
        new CustomerPriceGroupCatalogUnavailable({
          code: 'customer_price_group_catalog_unavailable',
          reason: 'Owner unavailable',
        }),
      ),
    );
    const failure = yield* Effect.flip(resolveCustomerPriceGroupAt(profile, [assignment], operationAt, catalog));
    expect(Schema.is(CustomerPriceGroupCatalogUnavailable)(failure)).toBe(true);
    expect(assignment.compatibility).toEqual(evidence);
  }),
);

const scheduleServices = () => {
  const requests: ValidatePriceGroupCompatibilityRequest[] = [];
  const stored: {
    readonly effectiveFrom: CustomerPriceGroupAssignment['effectiveFrom'];
    readonly trustedOperationAt: PriceGroupCompatibilityEvidence['trustedOperationAt'];
  }[] = [];
  const services: AssignCounterpartyPriceGroupServices = {
    catalog: priceGroupCatalogPort('b2-schedule', (request) => {
      requests.push(request);
      return Schema.decodeUnknownEffect(PriceGroupCompatibilityDecisionSchema)({
        evidence: {
          ...evidence,
          priceGroupRef: request.priceGroupRef,
          trustedOperationAt: request.trustedOperationAt,
          verifiedAt: operationAt,
        },
        kind: 'USABLE',
      }).pipe(
        Effect.mapError(
          () =>
            new CustomerPriceGroupCatalogUnavailable({
              code: 'customer_price_group_catalog_unavailable',
              reason: 'A future operation cannot already have been verified.',
            }),
        ),
      );
    }),
    now: Effect.succeed(operationAt),
    profileValidation: {
      inspect: (target) =>
        Effect.succeed({
          _tag: 'CURRENT',
          counterpartyRef: target.kind === 'COUNTERPARTY' ? counterpartyRef : null,
          revision: 1,
          state: 'ACTIVE',
        }),
    },
    store: {
      assign: (input) => {
        stored.push({ effectiveFrom: input.effectiveFrom, trustedOperationAt: input.compatibility.trustedOperationAt });
        return Effect.succeed({
          _tag: 'assigned',
          assignment: {
            ...assignment,
            compatibility: input.compatibility,
            effectiveFrom: input.effectiveFrom,
            priceGroupRef: input.priceGroupRef,
            profile: input.profile,
            recordedAt: input.recordedAt,
          },
          changed: false,
          replacedAssignmentRef: null,
        });
      },
      list: () => Effect.die('Unexpected assignment read'),
      migrate: (input) => {
        stored.push({ effectiveFrom: input.effectiveFrom, trustedOperationAt: input.compatibility.trustedOperationAt });
        return Effect.succeed({ _tag: 'applied', assignments: [], changed: false });
      },
      remove: () => Effect.die('Unexpected removal'),
      resolve: () => Effect.die('Unexpected resolution'),
    },
  };
  return { requests, services, stored };
};

const contextFor = <Events extends DomainEventContractMap>(
  descriptor: { readonly accessEvidencePolicy: ActionAccessEvidencePolicy; readonly domainEvents: Events },
  services: AssignCounterpartyPriceGroupServices,
) => {
  const collector = createActionCollector(
    descriptor.domainEvents,
    'commerce.customer-context',
    descriptor.accessEvidencePolicy,
  );
  return {
    actionInvocationId: crypto.randomUUID(),
    addDomainEvent: collector.addDomainEvent,
    addOutboxMessage: collector.addOutboxMessage,
    compositionRevision: originalCompositionRevision,
    recordAuditEvidence: collector.recordAuditEvidence,
    recordDataAccess: collector.recordDataAccess,
    scope: {
      authMethod: 'system' as const,
      correlationId: 'b2-schedule',
      legalEntityId: '334a0000-0000-4000-8000-000000000009',
      principalId: '334a0000-0000-4000-8000-000000000010',
      tenantId,
    },
    services,
  };
};
const assignPayload = {
  effectiveFrom: scheduledAt,
  expectedProfileRevision: 1,
  priceGroupRef: group,
  profile,
  reason: 'Scheduled assignment',
};
const migrationPayload = {
  effectiveFrom: scheduledAt,
  reason: 'Scheduled migration',
  sourcePriceGroupRef: { ...group, resourceId: '334a0000-0000-4000-8000-000000000011' },
  targetPriceGroupRef: group,
  targets: [{ assignmentRef, expectedProfileRevision: 1, expectedRevision: 1, profile }],
};

it.effect('B2 validates all four scheduled assignment and migration Actions at the server operation time', () =>
  Effect.gen(function* separateOperationAndEffectiveTimes() {
    const { requests, services, stored } = scheduleServices();
    yield* getActionHandler(assignCustomerPriceGroupAction)(
      assignPayload,
      contextFor(assignCustomerPriceGroupAction.descriptor, services),
    );
    yield* getActionHandler(assignCounterpartyPriceGroupAction)(
      { ...assignPayload, counterpartyRef, profile: counterpartyProfile },
      contextFor(assignCounterpartyPriceGroupAction.descriptor, services),
    );
    yield* getActionHandler(migrateCustomerPriceGroupAction)(
      migrationPayload,
      contextFor(migrateCustomerPriceGroupAction.descriptor, services),
    );
    yield* getActionHandler(migrateCounterpartyPriceGroupAction)(
      {
        ...migrationPayload,
        counterpartyRef,
        targets: [{ assignmentRef, expectedProfileRevision: 1, expectedRevision: 1, profile: counterpartyProfile }],
      },
      contextFor(migrateCounterpartyPriceGroupAction.descriptor, services),
    );
    expect(requests.map((request) => request.trustedOperationAt)).toEqual([
      operationAt,
      operationAt,
      operationAt,
      operationAt,
    ]);
    expect(stored).toHaveLength(4);
    expect(
      stored.every((input) => input.effectiveFrom === scheduledAt && input.trustedOperationAt === operationAt),
    ).toBe(true);
  }),
);
