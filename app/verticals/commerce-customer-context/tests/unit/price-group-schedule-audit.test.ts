import { ActionAlreadyCommitted } from '@app/core-runtime';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  CustomerPriceGroupAssignedAuditEvidenceSchema,
  CustomerPriceGroupRemovedAuditEvidenceSchema,
} from '../../shared/domain/price-group-contracts.ts';
import type { CustomerPriceGroupAssignment } from '../../shared/domain/price-group-contracts.ts';
import type { CustomerPriceGroupAssignmentStorePort } from '../../shared/domain/price-group-ports.ts';
import { assignCustomerPriceGroupAction } from '../../src/actions/assign-customer-price-group.action.ts';
import { removeCustomerPriceGroupAction } from '../../src/actions/remove-customer-price-group.action.ts';

const tenantId = '12480000-0000-4000-8000-000000000001';
const principal = {
  authBindingId: '12480000-0000-4000-8000-000000000002',
  authContextRef: 'session:price-group-schedule-audit',
  authMethod: 'session',
  legalEntityId: '12480000-0000-4000-8000-000000000003',
  principalId: '12480000-0000-4000-8000-000000000004',
  tenantId,
} as const;
const from = '2027-01-01T00:00:00.000Z';
const end = '2027-06-01T00:00:00.000Z';
const profile = {
  kind: 'RETAIL',
  moduleId: 'commerce.customer-context',
  resourceId: 'profile',
  resourceType: 'commerce.customer-context.retail-customer-profile',
  tenantId,
} as const;
const group = {
  moduleId: 'pricing.price-group-catalog',
  resourceId: 'group',
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId,
} as const;
const ref = (resourceId: string): CustomerPriceGroupAssignment['assignmentRef'] => ({
  moduleId: 'commerce.customer-context',
  resourceId,
  resourceType: 'commerce.customer-context.customer-price-group-assignment',
  tenantId,
});
const unreachable = () => Effect.die('Unexpected store operation');
const unusedStore: CustomerPriceGroupAssignmentStorePort = {
  assign: unreachable,
  list: unreachable,
  migrate: unreachable,
  remove: unreachable,
  resolve: unreachable,
};
const assignment = (resourceId: string, effectiveTo: string | null = end): CustomerPriceGroupAssignment => ({
  assignmentRef: ref(resourceId),
  effectiveFrom: from,
  effectiveTo,
  priceGroupRef: group,
  profile,
  reason: 'A valid original reason',
  recordedAt: from,
  revision: 2,
  state: 'ACTIVE' as const,
});
const compatibility = {
  catalogRevision: 1,
  definitionEffectivePeriod: { effectiveFrom: from, effectiveTo: null },
  definitionRevisionId: '12480000-0000-4000-8000-000000000005',
  definitionRevisionNumber: 1,
  meaningFingerprint: 'a'.repeat(64),
  priceGroupRef: group,
  requiredContract: { contractId: 'commerce.customer-price-group-assignment.v1', version: 1 },
  trustedOperationAt: from,
  verifiedAt: from,
};
const permissions = {
  actionPermission: 'allowed',
  resourcePermission: 'allowed',
} as const;

it.effect('retains the finite request rather than a truncated replay row, and does not duplicate a committed key', () =>
  Effect.gen(function* retainOriginalRequest() {
    const services = {
      catalog: {
        resolveCurrent: () => Effect.succeed({ _tag: 'USABLE' as const, compatibility, priceGroupRef: group }),
      },
      now: Effect.succeed(from),
      profileValidation: {
        inspect: () =>
          Effect.succeed({ _tag: 'CURRENT' as const, counterpartyRef: null, revision: 1, state: 'ACTIVE' as const }),
      },
      store: {
        ...unusedStore,
        assign: () =>
          Effect.succeed({
            _tag: 'assigned' as const,
            assignment: assignment('assignment', '2027-03-01T00:00:00.000Z'),
            changed: false,
            replacedAssignmentRef: ref('predecessor'),
          }),
      },
    };
    const harness = yield* makeActionTestHarness({
      ...permissions,
      services: [bindActionTestServices(assignCustomerPriceGroupAction, services)],
    });
    const request = {
      payload: {
        effectiveFrom: from,
        effectiveTo: end,
        expectedProfileRevision: 1,
        priceGroupRef: group,
        profile,
        reason: 'Original finite intent',
      },
      principal,
      registration: assignCustomerPriceGroupAction,
      transport: { correlationId: 'finite-request', idempotencyKey: 'finite-request' },
    };
    const result = yield* harness.runtime.runAction(request);
    expect(result.assignment.effectiveTo).toBe('2027-03-01T00:00:00.000Z');
    const { committed } = harness.snapshot();
    expect(committed).toHaveLength(1);
    expect(committed[0]?.evidence.auditEvidence).toEqual({
      assignmentId: 'assignment',
      assignmentRevision: 2,
      changed: false,
      operation: 'ASSIGN',
      replacedAssignmentId: 'predecessor',
      requestedEffectiveFrom: from,
      requestedEffectiveTo: end,
    });
    expect(committed[0]?.evidence.domainEvents).toHaveLength(0);
    const replay = yield* Effect.flip(harness.runtime.runAction(request));
    expect(Schema.is(ActionAlreadyCommitted)(replay)).toBe(true);
    expect(harness.snapshot().committed).toHaveLength(1);
  }),
);

it.effect('collects worst escaped identifiers and open schedules below the actual 4096 byte cap', () =>
  Effect.gen(function* collectWorstValidIntent() {
    const id = '\u0000'.repeat(300);
    const services = {
      catalog: {
        resolveCurrent: () => Effect.succeed({ _tag: 'USABLE' as const, compatibility, priceGroupRef: group }),
      },
      now: Effect.succeed(from),
      profileValidation: {
        inspect: () =>
          Effect.succeed({ _tag: 'CURRENT' as const, counterpartyRef: null, revision: 1, state: 'ACTIVE' as const }),
      },
      store: {
        ...unusedStore,
        assign: () =>
          Effect.succeed({
            _tag: 'assigned' as const,
            assignment: { ...assignment(id, null), revision: Number.MAX_SAFE_INTEGER },
            changed: false,
            replacedAssignmentRef: ref(id),
          }),
      },
    };
    const harness = yield* makeActionTestHarness({
      ...permissions,
      services: [bindActionTestServices(assignCustomerPriceGroupAction, services)],
    });
    yield* harness.runtime.runAction({
      payload: {
        effectiveFrom: from,
        expectedProfileRevision: 1,
        priceGroupRef: group,
        profile,
        reason: '界'.repeat(1000),
      },
      principal,
      registration: assignCustomerPriceGroupAction,
      transport: { correlationId: 'worst-open', idempotencyKey: 'worst-open' },
    });
    const custom = harness.snapshot().committed[0]?.evidence.auditEvidence;
    expect(Schema.is(CustomerPriceGroupAssignedAuditEvidenceSchema)(custom)).toBe(true);
    expect(custom).not.toHaveProperty('requestedEffectiveTo');
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(CustomerPriceGroupAssignedAuditEvidenceSchema))(
      Schema.decodeUnknownSync(CustomerPriceGroupAssignedAuditEvidenceSchema)(custom),
    );
    expect(new TextEncoder().encode(encoded).byteLength).toBeLessThanOrEqual(4096);
  }),
);

it.effect('records exact cancellation instants without imposing a nonempty interval', () =>
  Effect.gen(function* collectCancellation() {
    const services = {
      now: Effect.succeed(from),
      store: {
        ...unusedStore,
        remove: () =>
          Effect.succeed({
            _tag: 'removed' as const,
            assignment: { ...assignment('cancelled', from), state: 'CANCELLED' as const },
            changed: false,
          }),
      },
    };
    const harness = yield* makeActionTestHarness({
      ...permissions,
      services: [bindActionTestServices(removeCustomerPriceGroupAction, services)],
    });
    yield* harness.runtime.runAction({
      payload: {
        assignmentRef: ref('cancelled'),
        effectiveAt: from,
        expectedRevision: 2,
        profile,
        reason: 'Cancel at start',
      },
      principal,
      registration: removeCustomerPriceGroupAction,
      transport: { correlationId: 'cancel-at-start', idempotencyKey: 'cancel-at-start' },
    });
    expect(harness.snapshot().committed[0]?.evidence.auditEvidence).toEqual({
      assignmentId: 'cancelled',
      assignmentRevision: 2,
      changed: false,
      operation: 'REMOVE',
      requestedEffectiveAt: from,
    });
    expect(
      Schema.is(CustomerPriceGroupRemovedAuditEvidenceSchema)({
        assignmentId: 'cancelled',
        assignmentRevision: 2,
        changed: false,
        operation: 'REMOVE',
        requestedEffectiveAt: from,
      }),
    ).toBe(true);
  }),
);

it('does not infer an original open schedule from legacy evidence', () => {
  expect(Schema.is(CustomerPriceGroupAssignedAuditEvidenceSchema)({ actionKey: 'legacy', resultHash: 'opaque' })).toBe(
    false,
  );
  expect(
    Schema.is(CustomerPriceGroupAssignedAuditEvidenceSchema)({
      assignmentId: 'assignment',
      assignmentRevision: 1,
      changed: true,
      operation: 'ASSIGN',
      requestedEffectiveFrom: from,
      requestedEffectiveTo: 'invalid',
    }),
  ).toBe(false);
});
