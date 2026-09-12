// @effect-diagnostics nodeBuiltinImport:off -- Checked-in migration SQL is the security contract; expires: 2027-03-01.
/* eslint-disable effect-native/no-manual-tag-comparison -- Persistence tests assert exact audited routine-to-domain outcome mappings; expires: 2027-03-01. */
import { readFileSync } from 'node:fs';

import type { OperationalScope, ScopedRoutineDefinition } from '@app/core-runtime';
import { Effect, Match, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { CommerceCustomerProfileTarget } from '../../shared/domain/price-group-contracts.ts';
import { CustomerPriceGroupPersistenceUnavailable } from '../../shared/domain/price-group-errors.ts';
import {
  customerPriceGroupAssignmentStoreForTransaction,
  customerPriceGroupProfileValidationForTransaction,
  priceGroupRoutineAllowlist,
} from '../../src/persistence/price-group-persistence.ts';
import type { PriceGroupRoutineInvoker } from '../../src/persistence/price-group-persistence.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const principalId = '30000000-0000-4000-8000-000000000001';
const actionInvocationId = '40000000-0000-4000-8000-000000000001';
const profileId = '50000000-0000-4000-8000-000000000001';
const assignmentId = '60000000-0000-4000-8000-000000000001';
const replacementId = '60000000-0000-4000-8000-000000000002';

const scopeFields = {
  authBindingId: '70000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:price-persistence-test',
  authMethod: 'session',
  correlationId: 'price-persistence-test',
  legalEntityId,
  principalId,
  tenantId,
} as const;
// SAFETY: the fixed UUID and session fields satisfy the trusted test-context contract.
const scope = scopeFields as OperationalScope & { readonly legalEntityId: string };

const profile: CommerceCustomerProfileTarget = {
  kind: 'RETAIL',
  moduleId: 'commerce.customer-context',
  resourceId: profileId,
  resourceType: 'commerce.customer-context.retail-customer-profile',
  tenantId,
};

const counterpartyRef = {
  moduleId: 'party.registry',
  resourceId: 'counterparty-1',
  resourceType: 'party.registry.counterparty',
  tenantId,
} as const;

const counterpartyProfile: CommerceCustomerProfileTarget = {
  kind: 'COUNTERPARTY',
  moduleId: 'commerce.customer-context',
  resourceId: profileId,
  resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
  tenantId,
};

const priceGroupRef = {
  moduleId: 'pricing.catalog',
  resourceId: 'contract-pricing',
  resourceType: 'pricing.catalog.price-group',
  tenantId,
} as const;

const compatibility = {
  catalogRevision: 7,
  contractId: 'commerce.customer-price-group-assignment.v1',
  contractRevision: 1,
  definitionRevision: 4,
} as const;

const assignmentRow = {
  assignment_id: assignmentId,
  catalog_revision: 7,
  compatibility_contract_id: 'commerce.customer-price-group-assignment.v1',
  compatibility_contract_revision: 1,
  definition_revision: 4,
  effective_from: '2026-09-09T10:00:00.000Z',
  effective_to: null,
  lifecycle: 'ACTIVE',
  price_group_module_id: 'pricing.catalog',
  price_group_resource_id: 'contract-pricing',
  price_group_resource_type: 'pricing.catalog.price-group',
  reason: 'Negotiated terms',
  recorded_at: '2026-09-09T09:00:00.000Z',
  revision: 1,
} as const;

const transactionReturning = (
  rows: readonly object[],
  calls: Readonly<{ readonly name: string; readonly values: readonly unknown[] }>[] = [],
) => {
  const fake = {
    invoke: (routine: ScopedRoutineDefinition, values: readonly unknown[]) => {
      calls.push({ name: routine.name, values });
      return Effect.succeed(rows);
    },
  };
  // SAFETY: persistence adapters receive only `invoke`; this fake implements that exact test seam.
  return fake as PriceGroupRoutineInvoker;
};

it('declares an immutable six-routine allowlist with Core-injected scope first', () => {
  expect(priceGroupRoutineAllowlist.map(({ name }) => name)).toEqual([
    'inspect_price_group_profile',
    'read_price_group_assignments',
    'resolve_price_group_assignments',
    'assign_price_group',
    'remove_price_group_assignment',
    'migrate_price_group_assignments',
  ]);
  for (const routine of priceGroupRoutineAllowlist) {
    expect(Object.isFrozen(routine)).toBe(true);
    expect(routine.ownerModuleKey).toBe('commerce.customer-context');
    expect(routine.parameters.slice(0, 2)).toEqual([
      { source: 'tenantId', type: 'uuid' },
      { source: 'legalEntityId', type: 'uuid' },
    ]);
  }
});

it.effect('maps profile reconciliation and exact Counterparty association from the atomic gate', () =>
  Effect.gen(function* profileGate() {
    const calls: { readonly name: string; readonly values: readonly unknown[] }[] = [];
    const validation = customerPriceGroupProfileValidationForTransaction(
      transactionReturning(
        [
          {
            counterparty_resource_id: counterpartyRef.resourceId,
            outcome: 'CURRENT',
            profile_state: 'RECONCILIATION_REQUIRED',
            revision: 3,
          },
        ],
        calls,
      ),
      scope,
    );
    const result = yield* validation.inspect(counterpartyProfile, '2026-09-09T10:00:00.000Z', counterpartyRef);
    const current = Match.value(result).pipe(
      Match.tag('CURRENT', (value) => value),
      Match.tag('NOT_FOUND', () => null),
      Match.exhaustive,
    );
    expect(current).toMatchObject({
      counterpartyRef,
      revision: 3,
      state: 'RECONCILIATION_REQUIRED',
    });
    expect(calls).toEqual([
      {
        name: 'inspect_price_group_profile',
        values: [profileId, 'COUNTERPARTY', '2026-09-09T10:00:00.000Z', counterpartyRef.resourceId],
      },
    ]);
  }),
);

it.effect('resolves only assignments effective at the trusted instant', () =>
  Effect.gen(function* resolutionLookup() {
    const calls: { readonly name: string; readonly values: readonly unknown[] }[] = [];
    const store = customerPriceGroupAssignmentStoreForTransaction(
      transactionReturning([{ ...assignmentRow, outcome: 'FOUND' }], calls),
      scope,
    );
    const result = yield* store.resolve(profile, '2026-09-09T10:00:00.000Z');
    const found = Match.value(result).pipe(
      Match.tag('found', (value) => value),
      Match.tag('profile_not_found', () => null),
      Match.exhaustive,
    );
    expect(found?.assignments).toHaveLength(1);
    expect(calls).toEqual([
      {
        name: 'resolve_price_group_assignments',
        values: [profileId, 'RETAIL', '2026-09-09T10:00:00.000Z'],
      },
    ]);
  }),
);

it.effect('maps business-equivalent assignment replay without changing history', () =>
  Effect.gen(function* assignReplay() {
    const store = customerPriceGroupAssignmentStoreForTransaction(
      transactionReturning([
        {
          ...assignmentRow,
          changed: false,
          outcome: 'UNCHANGED',
          profile_state: null,
          replaced_assignment_id: null,
        },
      ]),
      scope,
    );
    const result = yield* store.assign({
      actionInvocationId,
      compatibility,
      effectiveFrom: '2026-09-09T10:00:00.000Z',
      effectiveTo: null,
      expectedProfileRevision: 3,
      priceGroupRef,
      principalId,
      profile,
      reason: 'Negotiated terms',
      recordedAt: '2026-09-09T09:00:00.000Z',
      tenantId,
    });
    const assigned = Match.value(result).pipe(
      Match.tag('assigned', (value) => value),
      Match.tag('overlap', () => null),
      Match.tag('profile_ineligible', () => null),
      Match.tag('profile_not_found', () => null),
      Match.tag('profile_revision_conflict', () => null),
      Match.tag('retroactive_schedule', () => null),
      Match.exhaustive,
    );
    expect(assigned).toMatchObject({
      assignment: { assignmentRef: { resourceId: assignmentId }, revision: 1 },
      changed: false,
      replacedAssignmentRef: null,
    });
  }),
);

it.effect('preserves an atomic profile CAS race as a typed store conflict', () =>
  Effect.gen(function* assignmentCasConflict() {
    const store = customerPriceGroupAssignmentStoreForTransaction(
      transactionReturning([
        {
          ...Object.fromEntries(Object.keys(assignmentRow).map((key) => [key, null])),
          changed: false,
          outcome: 'PROFILE_REVISION_CONFLICT',
          profile_state: null,
          replaced_assignment_id: null,
        },
      ]),
      scope,
    );
    const result = yield* store.assign({
      actionInvocationId,
      compatibility,
      effectiveFrom: '2026-09-09T10:00:00.000Z',
      effectiveTo: null,
      expectedProfileRevision: 3,
      priceGroupRef,
      principalId,
      profile,
      reason: 'CAS race fixture',
      recordedAt: '2026-09-09T09:00:00.000Z',
      tenantId,
    });
    expect(result).toEqual({ _tag: 'profile_revision_conflict' });
  }),
);

it.effect('maps exact revision and removal conflicts without leaking routine details', () =>
  Effect.gen(function* removalConflict() {
    const store = customerPriceGroupAssignmentStoreForTransaction(
      transactionReturning([
        {
          ...Object.fromEntries(Object.keys(assignmentRow).map((key) => [key, null])),
          changed: false,
          current_revision: 8,
          outcome: 'REVISION_CONFLICT',
        },
      ]),
      scope,
    );
    const result = yield* store.remove({
      actionInvocationId,
      assignmentRef: {
        moduleId: 'commerce.customer-context',
        resourceId: assignmentId,
        resourceType: 'commerce.customer-context.customer-price-group-assignment',
        tenantId,
      },
      effectiveAt: '2026-10-01T00:00:00.000Z',
      expectedRevision: 7,
      principalId,
      profile,
      reason: 'Contract ended',
      recordedAt: '2026-09-09T09:00:00.000Z',
      tenantId,
    });
    const currentRevision = Match.value(result).pipe(
      Match.tag('revision_conflict', ({ currentRevision: value }) => value),
      Match.orElse(() => null),
    );
    expect(currentRevision).toBe(8);
  }),
);

it.effect('returns the complete migration conflict inventory without partial success', () =>
  Effect.gen(function* migrationConflict() {
    const store = customerPriceGroupAssignmentStoreForTransaction(
      transactionReturning([
        {
          ...Object.fromEntries(Object.keys(assignmentRow).map((key) => [key, null])),
          changed: false,
          conflict_assignment_id: assignmentId,
          conflict_reason: 'ASSIGNMENT_CHANGED',
          outcome: 'CONFLICTS',
          profile_id: null,
          profile_kind: null,
        },
        {
          ...Object.fromEntries(Object.keys(assignmentRow).map((key) => [key, null])),
          changed: false,
          conflict_assignment_id: replacementId,
          conflict_reason: 'OVERLAP',
          outcome: 'CONFLICTS',
          profile_id: null,
          profile_kind: null,
        },
      ]),
      scope,
    );
    const target = (resourceId: string) => ({
      assignmentRef: {
        moduleId: 'commerce.customer-context' as const,
        resourceId,
        resourceType: 'commerce.customer-context.customer-price-group-assignment' as const,
        tenantId,
      },
      expectedProfileRevision: 3,
      expectedRevision: 2,
      profile,
    });
    const result = yield* store.migrate({
      actionInvocationId,
      compatibility,
      effectiveFrom: '2026-10-01T00:00:00.000Z',
      principalId,
      reason: 'Catalog migration',
      recordedAt: '2026-09-09T09:00:00.000Z',
      sourcePriceGroupRef: priceGroupRef,
      targetPriceGroupRef: { ...priceGroupRef, resourceId: 'contract-pricing-v2' },
      targets: [target(assignmentId), target(replacementId)],
      tenantId,
    });
    const conflicts = Match.value(result).pipe(
      Match.tag('conflicts', ({ conflicts: value }) => value),
      Match.tag('applied', () => null),
      Match.tag('retroactive_schedule', () => null),
      Match.exhaustive,
    );
    expect(conflicts).toEqual([
      { assignmentRef: target(assignmentId).assignmentRef, reason: 'ASSIGNMENT_CHANGED' },
      { assignmentRef: target(replacementId).assignmentRef, reason: 'OVERLAP' },
    ]);
  }),
);

it.effect('maps atomic retroactive schedule rejection for every mutation family', () =>
  Effect.gen(function* retroactiveSchedule() {
    const nullable = Object.fromEntries(Object.keys(assignmentRow).map((key) => [key, null]));
    const assignmentStore = customerPriceGroupAssignmentStoreForTransaction(
      transactionReturning([
        {
          ...nullable,
          changed: false,
          outcome: 'RETROACTIVE_SCHEDULE',
          profile_state: null,
          replaced_assignment_id: null,
        },
      ]),
      scope,
    );
    const assignment = yield* assignmentStore.assign({
      actionInvocationId,
      compatibility,
      effectiveFrom: '2026-09-08T10:00:00.000Z',
      effectiveTo: null,
      expectedProfileRevision: 3,
      priceGroupRef,
      principalId,
      profile,
      reason: 'Retroactive fixture',
      recordedAt: '2026-09-09T09:00:00.000Z',
      tenantId,
    });

    const removalStore = customerPriceGroupAssignmentStoreForTransaction(
      transactionReturning([
        {
          ...nullable,
          changed: false,
          current_revision: 0,
          outcome: 'RETROACTIVE_SCHEDULE',
        },
      ]),
      scope,
    );
    const removal = yield* removalStore.remove({
      actionInvocationId,
      assignmentRef: {
        moduleId: 'commerce.customer-context',
        resourceId: assignmentId,
        resourceType: 'commerce.customer-context.customer-price-group-assignment',
        tenantId,
      },
      effectiveAt: '2026-09-08T10:00:00.000Z',
      expectedRevision: 1,
      principalId,
      profile,
      reason: 'Retroactive fixture',
      recordedAt: '2026-09-09T09:00:00.000Z',
      tenantId,
    });

    const migrationStore = customerPriceGroupAssignmentStoreForTransaction(
      transactionReturning([
        {
          ...nullable,
          changed: false,
          conflict_assignment_id: null,
          conflict_reason: null,
          outcome: 'RETROACTIVE_SCHEDULE',
          profile_id: null,
          profile_kind: null,
        },
      ]),
      scope,
    );
    const migration = yield* migrationStore.migrate({
      actionInvocationId,
      compatibility,
      effectiveFrom: '2026-09-08T10:00:00.000Z',
      principalId,
      reason: 'Retroactive fixture',
      recordedAt: '2026-09-09T09:00:00.000Z',
      sourcePriceGroupRef: priceGroupRef,
      targetPriceGroupRef: { ...priceGroupRef, resourceId: 'contract-pricing-v2' },
      targets: [
        {
          assignmentRef: {
            moduleId: 'commerce.customer-context',
            resourceId: assignmentId,
            resourceType: 'commerce.customer-context.customer-price-group-assignment',
            tenantId,
          },
          expectedProfileRevision: 3,
          expectedRevision: 1,
          profile,
        },
      ],
      tenantId,
    });

    expect(assignment).toEqual({ _tag: 'retroactive_schedule' });
    expect(removal).toEqual({ _tag: 'retroactive_schedule' });
    expect(migration).toEqual({ _tag: 'retroactive_schedule' });
  }),
);

it.effect('fails closed before invoking a routine for a cross-tenant profile', () =>
  Effect.gen(function* crossTenant() {
    const calls: { readonly name: string; readonly values: readonly unknown[] }[] = [];
    const store = customerPriceGroupAssignmentStoreForTransaction(transactionReturning([], calls), scope);
    const error = yield* Effect.flip(store.list({ ...profile, tenantId: '10000000-0000-4000-8000-000000000002' }));
    expect(Schema.is(CustomerPriceGroupPersistenceUnavailable)(error)).toBe(true);
    expect(calls).toEqual([]);
  }),
);

it('pins the clean-chain repair and exact SECURITY DEFINER privilege boundary', () => {
  const alignment = readFileSync(
    new URL('../../drizzle/20260909104256_align_customer_context_domain_contracts/migration.sql', import.meta.url),
    'utf-8',
  );
  const routines = readFileSync(
    new URL('../../drizzle/20260909112237_price-group-routines/migration.sql', import.meta.url),
    'utf-8',
  );

  expect(alignment).toContain('DROP CONSTRAINT IF EXISTS "ccc_price_assignments_compatibility_ck"');
  expect(routines.match(/SECURITY DEFINER/gu)).toHaveLength(6);
  expect(routines.match(/REVOKE ALL ON FUNCTION/gu)).toHaveLength(6);
  expect(routines.match(/GRANT EXECUTE ON FUNCTION/gu)).toHaveLength(6);
  expect(routines).toContain('SET search_path = pg_catalog, commerce_customer_context');
  expect(routines).toContain('SET row_security = on');
  expect(routines).toContain('FOR UPDATE');
  expect(routines).toContain('tstzrange(assignment.effective_from');
  expect(routines).toContain('counterparty.counterparty_resource_id = p_counterparty_resource_id');
  expect(routines).toContain('assignment.revision <> p_expected_revision');
  expect(routines.match(/p_effective_from < p_recorded_at/gu)).toHaveLength(2);
  expect(routines).toContain('p_effective_at < p_recorded_at');
  expect(routines).toContain('v_assignment.effective_to IS DISTINCT FROM p_effective_at');
  expect(routines).toContain("v_assignment.lifecycle IN ('ACTIVE', 'ENDED')");
  expect(routines).toContain('AND v_assignment.effective_to = p_effective_at');
  expect(routines).toContain("assignment.lifecycle IN ('ACTIVE', 'ENDED')");
  expect(routines).toContain('assignment.effective_from <= p_effective_from');
  expect(routines).toContain('assignment.effective_to IS NULL OR p_effective_from < assignment.effective_to');
  expect(routines).toContain(
    `"lifecycle" = 'CANCELLED' OR "effective_to" IS NULL OR "effective_to" > "effective_from"`,
  );
  expect(routines).toContain('history.recorded_at <= p_effective_at');
  expect(routines).toContain(
    'ORDER BY assignment.effective_from DESC, assignment.customer_price_group_assignment_id DESC',
  );
  expect(routines).toContain('LIMIT 200');
  expect(routines).toContain('ORDER BY selected.effective_from, selected.customer_price_group_assignment_id');
  expect(routines).toContain('resolve_price_group_assignments"(uuid, uuid, text, text, timestamptz)');
  expect(routines).toContain("assignment.lifecycle = 'ACTIVE'");
  expect(routines).toContain('assignment.effective_from <= p_effective_at');
  expect(routines).toContain('assignment.effective_to IS NULL OR p_effective_at < assignment.effective_to');
  expect(routines).toContain('LIMIT 2');
  expect(routines).toContain('inspect_price_group_profile"(uuid, uuid, text, text, timestamptz, text)');
  expect(routines).not.toMatch(/SET[^;]*action_invocation_id\s*=\s*p_action_invocation_id/su);
  expect(routines).not.toMatch(/GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)\s+ON/iu);
});
