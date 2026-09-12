// @effect-diagnostics nodeBuiltinImport:off -- Checked-in migration security is the contract under test; expires: 2027-03-31.
import { readFileSync } from 'node:fs';

import { ScopedRoutineInvocationError, TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Match, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CustomerGroupMeaningKeySchema } from '../../shared/domain/group-contract.ts';
import { CustomerGroupPersistenceUnavailable } from '../../shared/domain/group-errors.ts';
import { CustomerGroupMembershipRefSchema } from '../../shared/resources/customer-group-membership.ts';
import { CustomerGroupRefSchema } from '../../shared/resources/customer-group.ts';
import {
  customerGroupPersistenceForTransaction,
  customerGroupRoutineAllowlist,
} from '../../src/persistence/group-persistence.ts';
import type { CustomerGroupScopedRoutineInvoker } from '../../src/persistence/group-persistence.ts';
import type { ScopedRoutineDefinition } from '@app/core-runtime';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const groupId = '30000000-0000-4000-8000-000000000001';
const profileId = '40000000-0000-4000-8000-000000000001';
const membershipId = '50000000-0000-4000-8000-000000000001';
const principalId = '60000000-0000-4000-8000-000000000001';
const actionInvocationId = '70000000-0000-4000-8000-000000000001';
const recordedAt = '2026-09-09T10:00:00.000Z';

const groupRef = Schema.decodeUnknownSync(CustomerGroupRefSchema)({
  moduleId: 'commerce.customer-context',
  resourceId: groupId,
  resourceType: 'commerce.customer-context.customer-group',
  tenantId,
});
const profile = {
  profileKind: 'RETAIL' as const,
  profileRef: {
    moduleId: 'commerce.customer-context',
    resourceId: profileId,
    resourceType: 'commerce.customer-context.retail-customer-profile',
    tenantId,
  } as const,
};
const membershipRef = Schema.decodeUnknownSync(CustomerGroupMembershipRefSchema)({
  moduleId: 'commerce.customer-context',
  resourceId: membershipId,
  resourceType: 'commerce.customer-context.customer-group-membership',
  tenantId,
});
const meaningKey = Schema.decodeUnknownSync(CustomerGroupMeaningKeySchema)('dealer.relationship');
const mismatchedGroupRef = Schema.decodeUnknownSync(CustomerGroupRefSchema)({
  ...groupRef,
  tenantId: '10000000-0000-4000-8000-000000000099',
});
const definition = {
  changeKind: 'CREATED' as const,
  description: 'Independent dealers with an approved agreement.',
  membershipCriteria: 'A signed dealer agreement exists.',
  name: 'Dealers',
  purpose: 'Explainable dealer segmentation.',
  reason: 'Approved catalog definition',
  recordedAt,
  revision: 1,
};
const group = {
  businessCode: 'DEALERS',
  currentDefinition: definition,
  currentState: 'ACTIVE' as const,
  definitionHistory: [definition],
  groupRef,
  lifecycleHistory: [{ activeFrom: recordedAt, archivedAt: null, reason: definition.reason, recordedAt }],
  meaningKey,
  revision: 1,
};
const membership = {
  assignedAt: recordedAt,
  assignmentReason: 'Approved assignment',
  effectiveFrom: '2026-10-01T00:00:00.000Z',
  effectiveTo: null,
  groupRef,
  membershipRef,
  profile,
  removal: null,
  revision: 1,
  state: 'VALID' as const,
};

const trustedPrincipal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authBindingId: '80000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:group-persistence-test',
  authMethod: 'session',
  legalEntityId,
  principalId,
  tenantId,
});
const scope = {
  ...trustedPrincipal,
  correlationId: 'group-persistence-test',
  legalEntityId: Option.getOrThrow(Option.fromUndefinedOr(trustedPrincipal.legalEntityId)),
};

it('declares immutable exact group routine allowlist entries with Core-injected scope first', () => {
  expect(customerGroupRoutineAllowlist.map(({ name }) => name)).toEqual([
    'read_customer_group',
    'create_customer_group',
    'update_customer_group',
    'archive_customer_group',
    'reactivate_customer_group',
    'assign_customer_group_membership',
    'remove_customer_group_membership',
    'read_customer_group_members',
    'read_customer_group_history',
    'read_effective_customer_group_memberships',
  ]);
  for (const routine of customerGroupRoutineAllowlist) {
    expect(Object.isFrozen(routine)).toBe(true);
    expect(routine.parameters[0]).toEqual({ source: 'tenantId', type: 'uuid' });
    expect(routine.parameters[1]).toEqual({ source: 'legalEntityId', type: 'uuid' });
  }
});

it.effect('forwards exact actor and Action invocation attribution to create', () =>
  Effect.gen(function* createGroup() {
    let capturedValues: readonly unknown[] = [];
    // SAFETY: This test double exercises only createRoutine and returns its exact decoded row.
    const transaction = {
      invoke: (_routine: ScopedRoutineDefinition, values: readonly unknown[]) => {
        capturedValues = values;
        return Effect.succeed([
          {
            actual_revision: 1,
            changed: true,
            group_json: Option.some(group),
            outcome: 'CREATED',
          },
        ]);
      },
    } as CustomerGroupScopedRoutineInvoker;
    const persistence = customerGroupPersistenceForTransaction(transaction, scope);
    const outcome = yield* persistence.create({
      actionInvocationId,
      businessCode: 'DEALERS',
      description: definition.description,
      legalEntityId,
      meaningKey,
      membershipCriteria: definition.membershipCriteria,
      name: definition.name,
      principalId,
      purpose: definition.purpose,
      reason: definition.reason,
      recordedAt,
      tenantId,
    });
    expect(
      Match.value(outcome).pipe(
        Match.tag('created', () => true),
        Match.orElse(() => false),
      ),
    ).toBe(true);
    expect(capturedValues.slice(-2)).toEqual([principalId, actionInvocationId]);
  }),
);

it.effect('maps assignment, removal, and deterministic history documents without inventing scope', () =>
  Effect.gen(function* membershipPersistence() {
    const rows = [
      {
        changed: true,
        membership_json: Option.some(membership),
        outcome: 'ASSIGNED',
        profile_state: Option.none(),
      },
      {
        changed: false,
        membership_json: Option.some(membership),
        outcome: 'REMOVED',
        profile_state: Option.none(),
      },
      {
        group_json: Option.some(group),
        items_json: [membership],
        next_cursor: Option.some(membershipId),
        outcome: 'PRESENT',
      },
    ];
    let index = 0;
    const invokedValues: (readonly unknown[])[] = [];
    // SAFETY: Calls are ordered and every row is the exact decoded result of its invocation.
    const transaction = {
      invoke: (_routine: ScopedRoutineDefinition, values: readonly unknown[]) => {
        invokedValues.push(values);
        const row = rows[index] ?? rows[2];
        index += 1;
        return Effect.succeed([row]);
      },
    } as CustomerGroupScopedRoutineInvoker;
    const persistence = customerGroupPersistenceForTransaction(transaction, scope);
    const assigned = yield* persistence.assign({
      actionInvocationId,
      effectiveFrom: membership.effectiveFrom,
      effectiveTo: null,
      groupRef,
      legalEntityId,
      principalId,
      profile,
      reason: membership.assignmentReason,
      recordedAt,
      tenantId,
    });
    const removed = yield* persistence.remove({
      actionInvocationId,
      effectiveAt: '2026-11-01T00:00:00.000Z',
      groupRef,
      legalEntityId,
      membershipRef,
      principalId,
      profile,
      reason: 'Membership ended',
      recordedAt,
      tenantId,
    });
    const history = yield* persistence.history({
      asOf: null,
      cursor: null,
      groupRef,
      legalEntityId,
      limit: 50,
      tenantId,
    });
    expect(
      Match.value(assigned).pipe(
        Match.tag('assigned', () => true),
        Match.orElse(() => false),
      ),
    ).toBe(true);
    expect(
      Match.value(removed).pipe(
        Match.tag('removed', () => true),
        Match.orElse(() => false),
      ),
    ).toBe(true);
    expect(Option.getOrThrow(history).memberships).toEqual([membership]);
    expect(Option.getOrThrow(history).asOf).toBeNull();
    expect(Option.getOrThrow(history).nextCursor).toBe(membershipId);
    expect(invokedValues[2]).toEqual([groupId, null, null, 50]);
  }),
);

it.effect('fails closed before invocation when command scope disagrees with Core scope', () =>
  Effect.gen(function* mismatchedScope() {
    let invoked = false;
    // SAFETY: The mismatch must return before this deliberately unreachable generic test double.
    const transaction = {
      invoke: () => {
        invoked = true;
        return Effect.succeed([]);
      },
    } as CustomerGroupScopedRoutineInvoker;
    const persistence = customerGroupPersistenceForTransaction(transaction, scope);
    const error = yield* Effect.flip(
      persistence.detail({
        groupRef: mismatchedGroupRef,
        legalEntityId,
        tenantId,
      }),
    );
    expect(Schema.is(CustomerGroupPersistenceUnavailable)(error)).toBe(true);
    expect(invoked).toBe(false);
  }),
);

it.effect('rejects forged command actor attribution before routine invocation', () =>
  Effect.gen(function* forgedActor() {
    let invoked = false;
    // SAFETY: The actor mismatch must return before this deliberately unreachable generic test double.
    const transaction = {
      invoke: () => {
        invoked = true;
        return Effect.succeed([]);
      },
    } as CustomerGroupScopedRoutineInvoker;
    const persistence = customerGroupPersistenceForTransaction(transaction, scope);
    const error = yield* Effect.flip(
      persistence.create({
        actionInvocationId,
        businessCode: 'DEALERS',
        description: definition.description,
        legalEntityId,
        meaningKey,
        membershipCriteria: definition.membershipCriteria,
        name: definition.name,
        principalId: '60000000-0000-4000-8000-000000000099',
        purpose: definition.purpose,
        reason: definition.reason,
        recordedAt,
        tenantId,
      }),
    );
    expect(Schema.is(CustomerGroupPersistenceUnavailable)(error)).toBe(true);
    expect(invoked).toBe(false);
  }),
);

it.effect('sanitizes Core routine failures as the owner persistence error', () =>
  Effect.gen(function* routineFailure() {
    // SAFETY: This test double returns the exact Core routine failure for every invocation.
    const transaction = {
      invoke: () =>
        Effect.fail(
          new ScopedRoutineInvocationError({
            code: 'scoped_routine_invocation_failed',
            constraint: Option.none(),
            ownerModuleKey: 'commerce.customer-context',
            postgresCode: Option.none(),
            reason: 'private driver detail',
            routineKey: 'customer-group.read-detail',
          }),
        ),
    } as CustomerGroupScopedRoutineInvoker;
    const error = yield* Effect.flip(
      customerGroupPersistenceForTransaction(transaction, scope).detail({
        groupRef,
        legalEntityId,
        tenantId,
      }),
    );
    expect(Schema.is(CustomerGroupPersistenceUnavailable)(error)).toBe(true);
    expect(error.code).toBe('customer_group_persistence_unavailable');
    expect(error.reason).toContain('customer-group.read-detail');
    expect(error.reason).not.toContain('private driver detail');
  }),
);

it('locks down the checked-in SQL to exact scoped SECURITY DEFINER routine grants', () => {
  const migration = readFileSync(
    new URL('../../drizzle/20260909112233_group-routines/migration.sql', import.meta.url),
    'utf-8',
  );
  const forwardMigration = readFileSync(
    new URL('../../drizzle/20260909135000_refresh_customer_group_routines/migration.sql', import.meta.url),
    'utf-8',
  );
  const assignStart = migration.indexOf(
    'CREATE FUNCTION "commerce_customer_context"."assign_customer_group_membership"',
  );
  const firstLookupStart = migration.indexOf(
    'SELECT membership.customer_group_membership_id INTO v_membership_id',
    assignStart,
  );
  const firstLookupEnd = migration.indexOf('IF v_membership_id IS NOT NULL', firstLookupStart);
  const exactPeriodLookup = migration.slice(firstLookupStart, firstLookupEnd);
  const profileLifecycleGate = migration.indexOf("IF v_profile.lifecycle <> 'ACTIVE'", assignStart);
  const groupLifecycleGate = migration.indexOf("IF v_group.lifecycle <> 'ACTIVE'", assignStart);
  const overlapLookupStart = migration.indexOf(
    'SELECT membership.customer_group_membership_id INTO v_membership_id',
    firstLookupEnd,
  );
  const overlapLookupEnd = migration.indexOf('IF v_membership_id IS NOT NULL', overlapLookupStart);
  const overlapLookup = migration.slice(overlapLookupStart, overlapLookupEnd);
  expect(migration.match(/SECURITY DEFINER/gu)).toHaveLength(12);
  expect(migration.match(/routine scope mismatch/gu)).toHaveLength(10);
  expect(migration.match(/GRANT EXECUTE ON FUNCTION/gu)).toHaveLength(10);
  expect(migration).not.toMatch(/GRANT (?:SELECT|INSERT|UPDATE|DELETE|ALL) ON/gu);
  expect(migration).toContain('FOR UPDATE');
  expect(migration).toContain("tstzrange(p_effective_from, p_effective_to, '[)')");
  expect(migration).toContain("membership.lifecycle <> 'CANCELLED'");
  expect(migration).toContain("encode(sha256(convert_to(v_semantic_input, 'UTF8')), 'hex')");
  expect(migration).toContain('OR p_purpose IS DISTINCT FROM v_current_definition.purpose');
  expect(migration).toContain("'description', revision.description");
  expect(exactPeriodLookup).not.toContain('membership.lifecycle');
  expect(firstLookupStart).toBeLessThan(profileLifecycleGate);
  expect(firstLookupStart).toBeLessThan(groupLifecycleGate);
  expect(overlapLookup).toContain("membership.lifecycle <> 'CANCELLED'");
  expect(migration).toContain('customer_profile_lifecycle_history AS history');
  expect(migration).toContain('ORDER BY history.recorded_at DESC, history.revision DESC');
  expect(migration).toContain('p_as_of timestamptz');
  expect(migration).not.toContain("profile.lifecycle = 'ACTIVE'");
  expect(migration).toContain('ORDER BY membership.customer_group_membership_id::text');
  expect(migration).toContain('FROM PUBLIC, "ontos_runtime"');
  expect(forwardMigration.match(/CREATE OR REPLACE FUNCTION/gu)).toHaveLength(12);
  expect(forwardMigration.match(/GRANT EXECUTE ON FUNCTION/gu)).toHaveLength(10);
  expect(forwardMigration).toContain("routine.proname IN ('create_customer_group', 'update_customer_group')");
  expect(forwardMigration).toContain("'DROP FUNCTION %s'");
  expect(forwardMigration).toContain("IF v_profile.lifecycle <> 'ACTIVE'");
  expect(forwardMigration.indexOf('ALREADY_ASSIGNED')).toBeLessThan(
    forwardMigration.indexOf("IF v_profile.lifecycle <> 'ACTIVE'"),
  );
});
