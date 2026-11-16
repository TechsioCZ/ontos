import { runAction } from '@app/core-runtime';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { PgClient } from '@effect/sql-pg';
import { NodeChildProcessSpawner, NodeServices } from '@effect/platform-node';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { and, eq, sql } from 'drizzle-orm';
import { Effect, Layer, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  makeTestPgClient,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import {
  commerceCustomerContextRelations,
  customerGroupLifecyclePeriods,
  customerGroupMemberships,
  customerGroupMembershipSnapshotProofs,
  customerGroupMembershipSourceReceipts,
  customerGroupMembershipSourceRoutes,
  customerGroupRevisions,
  customerGroups,
  customerProfileLifecycleHistory,
  customerProfiles,
  profileReconciliationCases,
  customerSettingRevisions,
} from '../../src/database/schema.ts';
import type { CommerceCustomerContextTransaction } from '../../src/database/types.ts';
import { admitCustomerGroupMembershipSnapshotAction } from '../../src/actions/admit-customer-group-membership-snapshot.action.ts';
import { AdmitCustomerGroupMembershipSnapshotPayloadSchema } from '../../shared/domain/customer-group-membership-snapshot.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { CommerceSourceProcessingEligibility } from '../../src/integrations/source-processing-eligibility.ts';
import { commerceCustomerContextRegistration } from '../../vertical.registration.ts';
import { makeEnrollmentApplicationCompositionSnapshot } from '../support/enrollment-application-composition.ts';
import { makeVerifiedGatewayPrincipals } from '../support/verified-gateway-principal.ts';

const profileTemporal = 'c7100000-0000-4000-8000-000000000001';
const profileCancelled = 'c7100000-0000-4000-8000-000000000002';
const profilePeriods = 'c7100000-0000-4000-8000-000000000003';
const profileConcurrent = 'c7100000-0000-4000-8000-000000000004';
const profileSource = 'c7100000-0000-4000-8000-000000000006';
const profileRace = 'c7100000-0000-4000-8000-000000000005';

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Json));
const date = (value: string): Date => new Date(value);

interface RoutineOutcome extends Record<string, unknown> {
  readonly changed: boolean;
  readonly outcome: string;
}

interface GroupOutcome extends RoutineOutcome {
  readonly actual_revision: number;
  readonly group_json: {
    readonly groupRef: { readonly resourceId: string };
  } | null;
}

interface MembershipOutcome extends RoutineOutcome {
  readonly membership_json: {
    readonly management?: { readonly kind: string };
    readonly membershipRef: { readonly resourceId: string };
    readonly revision: number;
    readonly state: string;
  } | null;
}

interface SourceOutcome extends Record<string, unknown> {
  readonly outcome: string;
  readonly result: { readonly items: readonly unknown[] } | null;
}

interface ReadOutcome extends Record<string, unknown> {
  readonly items_json: readonly unknown[];
  readonly outcome: string;
}

const one = <Row>(rows: readonly Row[]): Row => {
  const [row] = rows;
  if (row === undefined) {
    throw new Error('Expected one routine result row');
  }
  return row;
};

it.live('preserves Customer Group temporal, replay, and concurrency invariants in PostgreSQL', () =>
  Effect.scoped(
    Effect.gen(function* postgresAcceptance() {
      const snapshot = yield* makeEnrollmentApplicationCompositionSnapshot(ultramodernApiMarker.buildMarker, [
        'privacy',
      ]);
      const { connections } = yield* makeIsolatedNativeDatabaseFixture({
        compositionSnapshot: snapshot,
        mode: 'schema-only',
        purpose: 'implementation-1096-registered-workload-gateway',
      });
      const fixture = yield* Effect.acquireRelease(
        makeLiveOperationFixture({
          access: 'allowed',
          actionExecutor: 'manager-only',
          actionKeys: [admitCustomerGroupMembershipSnapshotAction.descriptor.actionKey],
          adminConnectionString: Redacted.make(connections.admin.connectionString),
          allowedAudiences: ['commerce-customer-context'],
          applicationComposition: { load: Effect.succeed(snapshot) },
          authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
          compositionRevision: snapshot.composition.revision,
          expectedDeployment: ultramodernApiMarker,
          moduleKeys: ['commerce.customer-context'],
          ownerRegistration: commerceCustomerContextRegistration,
          runtimeConnectionString: Redacted.make(connections.runtime.connectionString),
        }),
        (resource) => resource.close().pipe(Effect.orDie),
      );
      const { legalEntityId, tenantId } = fixture;
      const principalId = 'c7000000-0000-4000-8000-000000000003';
      const authenticate = yield* makeVerifiedGatewayPrincipals({
        runtimeConnectionString: connections.runtime.connectionString,
        snapshot,
      });
      // INTERNAL_CONTRACT Privacy seam, as in the owner lifecycle suite. Snapshot admission
      // still executes the registered Action, actual Core transaction, producer and access evidence.
      const admissionContext = yield* Layer.build(
        Layer.succeed(CommerceSourceProcessingEligibility, { check: () => Effect.void }).pipe(
          Layer.provideMerge(fixture.layer),
        ),
      );
      const adminClient = yield* makeTestPgClient(connections.admin.connectionString);
      const runtimeClient = yield* makeTestPgClient(connections.runtime.connectionString, { maxConnections: 4 });
      const admin = yield* makeTestDatabaseFromClient(adminClient, commerceCustomerContextRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, commerceCustomerContextRelations);
      const coreEvidence = yield* testCoreDatabase.pipe(Effect.provideService(PgClient.PgClient, adminClient));

      const cleanup = () =>
        admin.transaction((transaction) =>
          Effect.gen(function* cleanFixtureScope() {
            // Test cleanup is isolated to this admin transaction. Runtime remains unable to bypass
            // the append-only triggers, which stay enabled for every production connection.
            yield* transaction.execute(sql`set local session_replication_role = 'replica'`);
            yield* transaction.execute(
              sql`delete from commerce_customer_context.profile_reconciliation_case_members where tenant_id = ${tenantId}`,
            );
            yield* transaction
              .delete(profileReconciliationCases)
              .where(eq(profileReconciliationCases.tenantId, tenantId));
            yield* transaction.execute(
              sql`delete from commerce_customer_context.retail_customer_profiles where tenant_id = ${tenantId}`,
            );
            yield* transaction
              .delete(customerGroupMembershipSnapshotProofs)
              .where(eq(customerGroupMembershipSnapshotProofs.tenantId, tenantId));
            yield* transaction
              .delete(customerGroupMembershipSourceReceipts)
              .where(eq(customerGroupMembershipSourceReceipts.tenantId, tenantId));
            yield* transaction
              .delete(customerGroupMembershipSourceRoutes)
              .where(eq(customerGroupMembershipSourceRoutes.tenantId, tenantId));
            yield* transaction.delete(customerGroupMemberships).where(eq(customerGroupMemberships.tenantId, tenantId));
            yield* transaction.delete(customerSettingRevisions).where(eq(customerSettingRevisions.tenantId, tenantId));
            yield* transaction
              .delete(customerGroupLifecyclePeriods)
              .where(eq(customerGroupLifecyclePeriods.tenantId, tenantId));
            yield* transaction.delete(customerGroupRevisions).where(eq(customerGroupRevisions.tenantId, tenantId));
            yield* transaction.delete(customerGroups).where(eq(customerGroups.tenantId, tenantId));
            yield* transaction
              .delete(customerProfileLifecycleHistory)
              .where(eq(customerProfileLifecycleHistory.tenantId, tenantId));
            yield* transaction.delete(customerProfiles).where(eq(customerProfiles.tenantId, tenantId));
          }),
        );

      const inScope = <Value, Failure>(
        operation: (transaction: CommerceCustomerContextTransaction) => Effect.Effect<Value, Failure>,
      ) =>
        runtime.transaction((transaction) =>
          Effect.gen(function* scopedOperation() {
            yield* transaction.execute(
              sql`select set_config('ontos.tenant_id', ${tenantId}, true), set_config('ontos.legal_entity_id', ${legalEntityId}, true)`,
              'objects',
            );
            return yield* operation(transaction);
          }),
        );

      const createGroup = (suffix: string, recordedAt: Date, invocationId: string) =>
        inScope((transaction) =>
          transaction
            .execute<GroupOutcome>(
              sql`select * from commerce_customer_context.create_customer_group(
                ${tenantId}::uuid,
                ${legalEntityId}::uuid,
                ${`GROUP_${suffix}`}::text,
                ${`test.group-${suffix.toLowerCase()}`}::text,
                ${`Description ${suffix}`}::text,
                ${`Criteria ${suffix}`}::text,
                ${`Group ${suffix}`}::text,
                ${`Purpose ${suffix}`}::text,
                ${'PostgreSQL acceptance fixture'}::text,
                ${recordedAt}::timestamptz,
                ${principalId}::uuid,
                ${invocationId}::uuid
              )`,
              'objects',
            )
            .pipe(Effect.map(one)),
        );

      const assign = (
        groupId: string,
        profileId: string,
        effectiveFrom: Date,
        effectiveTo: Date | null,
        recordedAt: Date,
        invocationId: string,
      ) =>
        inScope((transaction) =>
          transaction
            .execute<MembershipOutcome>(
              sql`select * from commerce_customer_context.assign_customer_group_membership(
                ${tenantId}::uuid,
                ${legalEntityId}::uuid,
                ${groupId}::uuid,
                ${profileId}::uuid,
                ${'RETAIL'}::text,
                ${effectiveFrom}::timestamptz,
                ${effectiveTo}::timestamptz,
                ${'PostgreSQL acceptance assignment'}::text,
                ${recordedAt}::timestamptz,
                ${principalId}::uuid,
                ${invocationId}::uuid
              )`,
              'objects',
            )
            .pipe(Effect.map(one)),
        );

      const remove = (
        membershipId: string,
        groupId: string,
        profileId: string,
        effectiveAt: Date,
        recordedAt: Date,
        invocationId: string,
        actor = principalId,
      ) =>
        inScope((transaction) =>
          transaction
            .execute<MembershipOutcome>(
              sql`select * from commerce_customer_context.remove_customer_group_membership(
                ${tenantId}::uuid,
                ${legalEntityId}::uuid,
                ${membershipId}::uuid,
                ${groupId}::uuid,
                ${profileId}::uuid,
                ${'RETAIL'}::text,
                ${effectiveAt}::timestamptz,
                ${'PostgreSQL acceptance removal'}::text,
                ${recordedAt}::timestamptz,
                ${actor}::uuid,
                ${invocationId}::uuid
              )`,
              'objects',
            )
            .pipe(Effect.map(one)),
        );

      const readEffective = (profileId: string, effectiveAt: Date) =>
        inScope((transaction) =>
          transaction
            .execute<ReadOutcome>(
              sql`select * from commerce_customer_context.read_effective_customer_group_memberships(
                ${tenantId}::uuid,
                ${legalEntityId}::uuid,
                ${profileId}::uuid,
                ${'RETAIL'}::text,
                ${effectiveAt}::timestamptz
              )`,
              'objects',
            )
            .pipe(Effect.map(one)),
        );

      const readHistoryAt = (groupId: string, asOf: Date) =>
        inScope((transaction) =>
          transaction
            .execute<ReadOutcome>(
              sql`select * from commerce_customer_context.read_customer_group_history(
                ${tenantId}::uuid,
                ${legalEntityId}::uuid,
                ${groupId}::uuid,
                ${asOf}::timestamptz,
                ${null}::text,
                ${50}::integer
              )`,
              'objects',
            )
            .pipe(Effect.map(one)),
        );

      const archive = (groupId: string, effectiveAt: Date, recordedAt: Date, invocationId: string) =>
        inScope((transaction) =>
          transaction
            .execute<GroupOutcome>(
              sql`select * from commerce_customer_context.archive_customer_group(
                ${tenantId}::uuid,
                ${legalEntityId}::uuid,
                ${groupId}::uuid,
                ${1}::integer,
                ${effectiveAt}::timestamptz,
                ${'PostgreSQL acceptance archive'}::text,
                ${recordedAt}::timestamptz,
                ${principalId}::uuid,
                ${invocationId}::uuid
              )`,
              'objects',
            )
            .pipe(Effect.map(one)),
        );

      yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));
      yield* cleanup();
      const profiles = [
        profileTemporal,
        profileCancelled,
        profilePeriods,
        profileConcurrent,
        profileRace,
        profileSource,
      ] as const;
      yield* admin.insert(customerProfiles).values(
        profiles.map((customerProfileId) => ({
          customerProfileId,
          legalEntityId,
          profileKind: 'RETAIL',
          tenantId,
        })),
      );
      yield* admin.insert(customerProfileLifecycleHistory).values(
        profiles.map((customerProfileId, index) => ({
          actionInvocationId: `c7200000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
          actorPrincipalId: principalId,
          customerProfileId,
          fromLifecycle: null,
          legalEntityId,
          reason: 'PostgreSQL acceptance profile fixture',
          recordedAt: date('2026-01-01T00:00:00.000Z'),
          revision: 1,
          tenantId,
          toLifecycle: 'ACTIVE',
        })),
      );

      const temporalGroup = yield* createGroup(
        'TEMPORAL',
        date('2026-01-01T00:00:00.000Z'),
        'c7300000-0000-4000-8000-000000000001',
      );
      const temporalGroupId = temporalGroup.group_json?.groupRef.resourceId;
      expect(temporalGroup.outcome).toBe('CREATED');
      expect(temporalGroupId).toBeDefined();
      if (temporalGroupId === undefined) {
        return;
      }
      const temporalAssignment = yield* assign(
        temporalGroupId,
        profileTemporal,
        date('2026-01-02T00:00:00.000Z'),
        null,
        date('2026-01-02T00:00:00.000Z'),
        'c7300000-0000-4000-8000-000000000002',
      );
      const temporalMembershipId = temporalAssignment.membership_json?.membershipRef.resourceId;
      expect(temporalAssignment.outcome).toBe('ASSIGNED');
      expect(temporalMembershipId).toBeDefined();
      if (temporalMembershipId === undefined) {
        return;
      }
      expect(
        (yield* remove(
          temporalMembershipId,
          temporalGroupId,
          profileTemporal,
          date('2026-02-01T00:00:00.000Z'),
          date('2026-01-15T00:00:00.000Z'),
          'c7300000-0000-4000-8000-000000000003',
        )).outcome,
      ).toBe('REMOVED');
      expect((yield* readEffective(profileTemporal, date('2026-01-31T23:59:59.999Z'))).items_json).toHaveLength(1);
      expect((yield* readEffective(profileTemporal, date('2026-02-01T00:00:00.000Z'))).items_json).toHaveLength(0);
      expect((yield* readHistoryAt(temporalGroupId, date('2026-01-31T23:59:59.999Z'))).items_json).toHaveLength(1);
      expect((yield* readHistoryAt(temporalGroupId, date('2026-02-01T00:00:00.000Z'))).items_json).toHaveLength(0);

      yield* admin
        .update(customerProfiles)
        .set({ lifecycle: 'SUSPENDED', revision: 2 })
        .where(eq(customerProfiles.customerProfileId, profileTemporal));
      yield* admin.insert(customerProfileLifecycleHistory).values({
        actionInvocationId: 'c7300000-0000-4000-8000-000000000004',
        actorPrincipalId: principalId,
        customerProfileId: profileTemporal,
        fromLifecycle: 'ACTIVE',
        legalEntityId,
        reason: 'PostgreSQL acceptance suspension',
        recordedAt: date('2026-01-20T00:00:00.000Z'),
        revision: 2,
        tenantId,
        toLifecycle: 'SUSPENDED',
      });
      expect((yield* readEffective(profileTemporal, date('2026-01-19T23:59:59.999Z'))).items_json).toHaveLength(1);
      expect((yield* readEffective(profileTemporal, date('2026-01-20T00:00:00.000Z'))).items_json).toHaveLength(0);

      const cancelledGroup = yield* createGroup(
        'CANCELLED',
        date('2026-01-01T00:00:00.000Z'),
        'c7400000-0000-4000-8000-000000000001',
      );
      const cancelledGroupId = cancelledGroup.group_json?.groupRef.resourceId;
      if (cancelledGroupId === undefined) {
        return;
      }
      const cancelledAssignment = yield* assign(
        cancelledGroupId,
        profileCancelled,
        date('2026-04-01T00:00:00.000Z'),
        date('2026-05-01T00:00:00.000Z'),
        date('2026-03-01T00:00:00.000Z'),
        'c7400000-0000-4000-8000-000000000002',
      );
      const cancelledMembershipId = cancelledAssignment.membership_json?.membershipRef.resourceId;
      if (cancelledMembershipId === undefined) {
        return;
      }
      expect(
        (yield* remove(
          cancelledMembershipId,
          cancelledGroupId,
          profileCancelled,
          date('2026-03-15T00:00:00.000Z'),
          date('2026-03-15T00:00:00.000Z'),
          'c7400000-0000-4000-8000-000000000003',
        )).membership_json?.state,
      ).toBe('CANCELLED');
      yield* admin
        .update(customerProfiles)
        .set({ lifecycle: 'SUSPENDED', revision: 2 })
        .where(eq(customerProfiles.customerProfileId, profileCancelled));
      expect(
        (yield* archive(
          cancelledGroupId,
          date('2026-03-20T00:00:00.000Z'),
          date('2026-03-20T00:00:00.000Z'),
          'c7400000-0000-4000-8000-000000000004',
        )).outcome,
      ).toBe('ARCHIVED');
      const cancelledReplay = yield* assign(
        cancelledGroupId,
        profileCancelled,
        date('2026-04-01T00:00:00.000Z'),
        date('2026-05-01T00:00:00.000Z'),
        date('2026-03-21T00:00:00.000Z'),
        'c7400000-0000-4000-8000-000000000005',
      );
      expect(cancelledReplay.outcome).toBe('ALREADY_ASSIGNED');
      expect(cancelledReplay.membership_json?.state).toBe('CANCELLED');

      const periodGroup = yield* createGroup(
        'PERIODS',
        date('2026-01-01T00:00:00.000Z'),
        'c7500000-0000-4000-8000-000000000001',
      );
      const periodGroupId = periodGroup.group_json?.groupRef.resourceId;
      if (periodGroupId === undefined) {
        return;
      }
      expect(
        (yield* assign(
          periodGroupId,
          profilePeriods,
          date('2026-02-01T00:00:00.000Z'),
          date('2026-03-01T00:00:00.000Z'),
          date('2026-01-10T00:00:00.000Z'),
          'c7500000-0000-4000-8000-000000000002',
        )).outcome,
      ).toBe('ASSIGNED');
      expect(
        (yield* assign(
          periodGroupId,
          profilePeriods,
          date('2026-03-01T00:00:00.000Z'),
          date('2026-04-01T00:00:00.000Z'),
          date('2026-01-10T00:00:00.000Z'),
          'c7500000-0000-4000-8000-000000000003',
        )).outcome,
      ).toBe('ASSIGNED');
      expect(
        (yield* assign(
          periodGroupId,
          profilePeriods,
          date('2026-02-15T00:00:00.000Z'),
          date('2026-03-15T00:00:00.000Z'),
          date('2026-01-10T00:00:00.000Z'),
          'c7500000-0000-4000-8000-000000000004',
        )).outcome,
      ).toBe('OVERLAP');

      const concurrentGroup = yield* createGroup(
        'CONCURRENT',
        date('2026-01-01T00:00:00.000Z'),
        'c7600000-0000-4000-8000-000000000001',
      );
      const concurrentGroupId = concurrentGroup.group_json?.groupRef.resourceId;
      if (concurrentGroupId === undefined) {
        return;
      }
      const concurrentOutcomes = yield* Effect.all(
        [
          assign(
            concurrentGroupId,
            profileConcurrent,
            date('2026-02-01T00:00:00.000Z'),
            null,
            date('2026-01-15T00:00:00.000Z'),
            'c7600000-0000-4000-8000-000000000002',
          ),
          assign(
            concurrentGroupId,
            profileConcurrent,
            date('2026-02-01T00:00:00.000Z'),
            null,
            date('2026-01-15T00:00:00.000Z'),
            'c7600000-0000-4000-8000-000000000003',
          ),
        ],
        { concurrency: 2 },
      );
      expect(new Set(concurrentOutcomes.map(({ outcome }) => outcome))).toEqual(
        new Set(['ALREADY_ASSIGNED', 'ASSIGNED']),
      );
      expect(
        yield* admin
          .select({ id: customerGroupMemberships.customerGroupMembershipId })
          .from(customerGroupMemberships)
          .where(
            and(
              eq(customerGroupMemberships.customerGroupId, concurrentGroupId),
              eq(customerGroupMemberships.customerProfileId, profileConcurrent),
            ),
          ),
      ).toHaveLength(1);

      const raceGroup = yield* createGroup(
        'RACE',
        date('2026-01-01T00:00:00.000Z'),
        'c7700000-0000-4000-8000-000000000001',
      );
      const raceGroupId = raceGroup.group_json?.groupRef.resourceId;
      if (raceGroupId === undefined) {
        return;
      }
      const [raceAssignment, raceArchive] = yield* Effect.all(
        [
          assign(
            raceGroupId,
            profileRace,
            date('2026-01-02T00:00:00.000Z'),
            null,
            date('2026-01-02T00:00:00.000Z'),
            'c7700000-0000-4000-8000-000000000002',
          ),
          archive(
            raceGroupId,
            date('2026-01-03T00:00:00.000Z'),
            date('2026-01-04T00:00:00.000Z'),
            'c7700000-0000-4000-8000-000000000003',
          ),
        ],
        { concurrency: 2 },
      );
      expect(['ASSIGNED', 'GROUP_INACTIVE']).toContain(raceAssignment.outcome);
      expect(raceArchive.outcome).toBe('ARCHIVED');
      expect((yield* readEffective(profileRace, date('2026-01-04T00:00:00.000Z'))).items_json).toHaveLength(0);

      const proveSourceMembership = Effect.fn('CustomerGroupPostgres.proveSourceMembership')(
        function* proveSourceMembership() {
          // INTERNAL_CONTRACT: this owner fixture does not describe any external provider.
          yield* admin.execute(sql`
          insert into commerce_customer_context.retail_customer_profiles
            (tenant_id, legal_entity_id, retail_customer_profile_id, party_resource_id)
          values (${tenantId}, ${legalEntityId}, ${profileSource}, ${'internal-contract-party'})
        `);
          const sourceE = fixture.manager.principalId;
          const sourceF = 'c7900000-0000-4000-8000-000000000002';
          yield* admin.insert(customerGroupMembershipSourceRoutes).values([
            {
              active: true,
              allowComplete: true,
              completenessContractCoverage: 'ALL_GROUP_MEMBERSHIPS_FOR_EXACT_PROFILE',
              completenessContractRef: 'internal-membership-completeness',
              completenessContractRevision: '1',
              issuer: 'internal-e',
              legalEntityId,
              principalId: sourceE,
              routeId: 'internal-e',
              routeRevision: '1',
              sourceNamespace: 'groups',
              tenantId,
            },
            {
              active: true,
              allowComplete: false,
              issuer: 'internal-f',
              legalEntityId,
              principalId: sourceF,
              routeId: 'internal-f',
              routeRevision: '1',
              sourceNamespace: 'groups',
              tenantId,
            },
          ]);
          const sourceGroup = (suffix: string) =>
            createGroup(suffix, date('2026-01-01T00:00:00.000Z'), crypto.randomUUID()).pipe(
              Effect.map(({ group_json }) => group_json?.groupRef.resourceId ?? ''),
            );
          const [manualGroup, eGroup, fGroup, unattributedGroup] = yield* Effect.all([
            sourceGroup('MANUAL'),
            sourceGroup('SOURCEE'),
            sourceGroup('SOURCEF'),
            sourceGroup('UNATTRIBUTED'),
          ]);
          const assignmentTime = '2026-01-08T00:00:00.000Z';
          const groupRef = (resourceId: string) => ({
            moduleId: 'commerce.customer-context',
            resourceId,
            resourceType: 'commerce.customer-context.customer-group',
            tenantId,
          });
          const command = (issuer: string, order: number, effectiveAt = assignmentTime) => ({
            effectiveAt,
            manager: { factFamily: 'CUSTOMER_GROUP_MEMBERSHIP', issuer, sourceNamespace: 'groups', tenantId },
            profile: {
              profileKind: 'RETAIL',
              profileRef: {
                moduleId: 'commerce.customer-context',
                resourceId: profileSource,
                resourceType: 'commerce.customer-context.retail-customer-profile',
                tenantId,
              },
            },
            reason: 'Internal owner contract fixture',
            route: { id: issuer, revision: '1' },
            source: {
              assertionId: `assertion-${order}`,
              effectId: `effect-${order}`,
              order,
              sourceRecordId: 'profile-record',
            },
          });
          const runSource = (actor: string, payload: Schema.Json) =>
            inScope((transaction) =>
              transaction
                .execute<SourceOutcome>(
                  sql`select * from commerce_customer_context.apply_customer_group_membership_source(
                ${tenantId}::uuid, ${legalEntityId}::uuid, ${actor}::uuid,
                ${crypto.randomUUID()}::uuid, clock_timestamp(),
                ${encodeJson(payload)}::jsonb
              )`,
                  'objects',
                )
                .pipe(Effect.map(one)),
            );
          const manual = yield* assign(
            manualGroup,
            profileSource,
            date(assignmentTime),
            null,
            date(assignmentTime),
            crypto.randomUUID(),
          );
          const legacy = yield* assign(
            unattributedGroup,
            profileSource,
            date(assignmentTime),
            null,
            date(assignmentTime),
            crypto.randomUUID(),
          );
          const legacyId = legacy.membership_json?.membershipRef.resourceId ?? '';
          yield* admin
            .update(customerGroupMemberships)
            .set({ management: { kind: 'LEGACY_UNATTRIBUTED' } })
            .where(eq(customerGroupMemberships.customerGroupMembershipId, legacyId));
          expect(manual.membership_json?.management).toEqual({ kind: 'MANUAL' });
          const manualId = manual.membership_json?.membershipRef.resourceId ?? '';
          expect(
            (yield* remove(
              manualId,
              manualGroup,
              profileSource,
              date('2026-01-15T00:00:00.000Z'),
              date(assignmentTime),
              crypto.randomUUID(),
              sourceE,
            )).outcome,
          ).toBe('SOURCE_AUTHORITY_DENIED');

          const assignE = { ...command('internal-e', 2), groupRef: groupRef(eGroup), operation: 'ASSIGN' };
          const [first, retry] = yield* Effect.all([runSource(sourceE, assignE), runSource(sourceE, assignE)], {
            concurrency: 2,
          });
          expect(new Set([first.outcome, retry.outcome])).toEqual(new Set(['APPLIED', 'REPLAY']));
          expect(first.result).toEqual(retry.result);
          expect(first.result?.items).toMatchObject([
            {
              membership: { management: { kind: 'EXTERNAL_SOURCE', manager: { issuer: 'internal-e' } } },
              outcome: 'ASSIGNED',
            },
          ]);
          expect((yield* runSource(sourceF, assignE)).outcome).toBe('SOURCE_AUTHORITY_DENIED');
          expect((yield* runSource(sourceE, { ...assignE, reason: 'Conflicting intent' })).outcome).toBe(
            'SOURCE_CONFLICT',
          );
          expect(
            (yield* runSource(sourceE, {
              ...command('internal-e', 1),
              groupRef: groupRef(eGroup),
              operation: 'ASSIGN',
            })).outcome,
          ).toBe('SOURCE_STALE');

          const assignF = { ...command('internal-f', 1), groupRef: groupRef(fGroup), operation: 'ASSIGN' };
          expect((yield* runSource(sourceF, assignF)).outcome).toBe('APPLIED');
          const satisfied = yield* runSource(sourceE, {
            ...command('internal-e', 3),
            groupRef: groupRef(manualGroup),
            operation: 'ASSIGN',
          });
          expect(satisfied.result?.items).toEqual([
            { groupRef: groupRef(manualGroup), outcome: 'SATISFIED_BY_OTHER_MANAGER' },
          ]);

          const complete = {
            ...command('internal-e', 4, '2026-01-15T00:00:00.000Z'),
            completenessProofRef: 'internal-complete-proof',
            groupRefs: [],
            operation: 'COMPLETE',
          };
          expect((yield* runSource(sourceE, complete)).outcome).toBe('SOURCE_AUTHORITY_DENIED');
          const clock = one(
            yield* admin.execute<{ readonly recordedAt: Date }>(
              sql`select clock_timestamp() as "recordedAt"`,
              'objects',
            ),
          );
          const { recordedAt } = clock;
          const expiresAt = new Date(recordedAt.getTime() + 60 * 60 * 1000).toISOString();
          const verifyComplete = Effect.fn('CustomerGroupPostgres.admitSnapshot')(function* admitSnapshot(
            payload: Schema.Json,
            expiry = expiresAt,
          ) {
            const admission = yield* Schema.decodeUnknownEffect(AdmitCustomerGroupMembershipSnapshotPayloadSchema)({
              completenessContract: {
                coverage: 'ALL_GROUP_MEMBERSHIPS_FOR_EXACT_PROFILE',
                ref: 'internal-membership-completeness',
                revision: '1',
              },
              expiresAt: expiry,
              snapshot: payload,
            });
            const result = yield* runAction({
              payload: admission,
              principal: yield* authenticate({ ...fixture.manager, legalEntityId }),
              registration: admitCustomerGroupMembershipSnapshotAction,
              transport: {
                correlationId: crypto.randomUUID(),
                idempotencyKey: crypto.randomUUID(),
                targetModuleKey: 'commerce.customer-context',
              },
            }).pipe(Effect.provideContext(admissionContext));
            const [published] = yield* admin
              .select()
              .from(customerGroupMembershipSnapshotProofs)
              .where(
                and(
                  eq(customerGroupMembershipSnapshotProofs.tenantId, tenantId),
                  eq(customerGroupMembershipSnapshotProofs.proofRef, result.proofRef),
                ),
              );
            expect(published?.qualifiedByActionInvocationId).toBeTypeOf('string');
            const evidence = yield* fixture.evidence(coreEvidence);
            const producerAccesses = evidence.accesses.filter(
              (access) => access.actionInvocationId === published?.qualifiedByActionInvocationId,
            );
            for (const target of [admission.snapshot.profile.profileRef, ...admission.snapshot.groupRefs]) {
              expect(producerAccesses).toContainEqual(
                expect.objectContaining({
                  evidenceCaptureMode: 'metadata_only',
                  evidencePayloadJson: null,
                  resultCount: 1,
                  targetModuleKey: target.moduleId,
                  targetResourceId: target.resourceId,
                  targetResourceType: target.resourceType,
                }),
              );
            }
            return result;
          });
          // Business-effective January membership time cannot make an already expired
          // completeness assertion valid at today's recorded admission time.
          const expired = yield* Effect.flip(verifyComplete(complete, '2026-01-21T00:00:00.000Z'));
          expect(expired).toMatchObject({ code: 'SOURCE_CONFLICT' });
          const admitted = yield* verifyComplete(complete);
          const [proof] = yield* admin
            .select()
            .from(customerGroupMembershipSnapshotProofs)
            .where(
              and(
                eq(customerGroupMembershipSnapshotProofs.tenantId, tenantId),
                eq(customerGroupMembershipSnapshotProofs.proofRef, admitted.proofRef),
              ),
            );
          expect(proof).toMatchObject({
            proofDigest: admitted.digest,
            qualifiedByPrincipalId: sourceE,
          });
          expect(proof?.qualifiedByActionInvocationId).toBeTypeOf('string');
          expect(proof?.qualifiedAt).toBeInstanceOf(Date);
          expect(proof?.expiresAt.getTime()).toBeGreaterThan(recordedAt.getTime());
          expect((yield* runSource(sourceE, { ...complete, groupRefs: [groupRef(manualGroup)] })).outcome).toBe(
            'SOURCE_AUTHORITY_DENIED',
          );
          const missing = {
            ...complete,
            completenessProofRef: 'internal-missing-group-proof',
            groupRefs: [groupRef(crypto.randomUUID())],
          };
          const beforeMissing = yield* readEffective(profileSource, date('2026-01-16T00:00:00.000Z'));
          // The current public producer rejects an absent Group before publishing authority.
          // An unadmitted snapshot cannot reach destructive reconciliation at all.
          expect(yield* Effect.flip(verifyComplete(missing))).toMatchObject({ code: 'TARGET_NOT_FOUND' });
          expect((yield* runSource(sourceE, missing)).outcome).toBe('SOURCE_AUTHORITY_DENIED');
          expect(
            yield* admin
              .select()
              .from(customerGroupMembershipSnapshotProofs)
              .where(
                and(
                  eq(customerGroupMembershipSnapshotProofs.tenantId, tenantId),
                  eq(customerGroupMembershipSnapshotProofs.proofRef, missing.completenessProofRef),
                ),
              ),
          ).toEqual([]);
          expect(yield* readEffective(profileSource, date('2026-01-16T00:00:00.000Z'))).toEqual(beforeMissing);
          expect(beforeMissing.items_json).toHaveLength(4);
          const cleared = yield* runSource(sourceE, complete);
          expect(cleared.result?.items).toMatchObject([
            { membership: { groupRef: groupRef(eGroup), removal: { source: complete.source } }, outcome: 'ENDED' },
          ]);
          expect((yield* runSource(sourceE, complete)).result).toEqual(cleared.result);
          expect((yield* readEffective(profileSource, date('2026-01-16T00:00:00.000Z'))).items_json).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ groupRef: groupRef(manualGroup), management: { kind: 'MANUAL' } }),
              expect.objectContaining({
                groupRef: groupRef(unattributedGroup),
                management: { kind: 'LEGACY_UNATTRIBUTED' },
              }),
              expect.objectContaining({
                groupRef: groupRef(fGroup),
                management: expect.objectContaining({ kind: 'EXTERNAL_SOURCE' }),
              }),
            ]),
          );
          expect((yield* readEffective(profileSource, date('2026-01-16T00:00:00.000Z'))).items_json).toHaveLength(3);
          const partialGroupA = yield* sourceGroup('PARTIALA');
          const partialGroupB = yield* sourceGroup('PARTIALB');
          const partial = {
            ...command('internal-e', 5, '2026-01-17T00:00:00.000Z'),
            groupRefs: [groupRef(partialGroupB), groupRef(partialGroupA)],
            operation: 'PARTIAL',
          };
          const additive = yield* runSource(sourceE, partial);
          expect(additive.outcome).toBe('APPLIED');
          expect(additive.result?.items).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                membership: expect.objectContaining({ groupRef: groupRef(partialGroupA) }),
                outcome: 'ASSIGNED',
              }),
              expect.objectContaining({
                membership: expect.objectContaining({ groupRef: groupRef(partialGroupB) }),
                outcome: 'ASSIGNED',
              }),
            ]),
          );
          expect(additive.result?.items).toHaveLength(2);
          expect(
            (yield* runSource(sourceE, { ...partial, groupRefs: [groupRef(partialGroupA), groupRef(partialGroupB)] }))
              .result,
          ).toEqual(additive.result);
          expect((yield* readEffective(profileSource, date('2026-01-18T00:00:00.000Z'))).items_json).toHaveLength(5);

          const reassertion = {
            ...command('internal-e', 6, '2026-01-18T00:00:00.000Z'),
            groupRef: groupRef(partialGroupA),
            operation: 'ASSIGN',
          };
          const reasserted = yield* runSource(sourceE, reassertion);
          const minimalResult = [{ groupRef: groupRef(partialGroupA), outcome: 'ALREADY_MANAGED' }];
          expect(reasserted.result?.items).toEqual(minimalResult);
          const [durableReassertion] = yield* admin
            .select({ result: customerGroupMembershipSourceReceipts.result })
            .from(customerGroupMembershipSourceReceipts)
            .where(
              and(
                eq(customerGroupMembershipSourceReceipts.tenantId, tenantId),
                eq(customerGroupMembershipSourceReceipts.effectId, reassertion.source.effectId),
              ),
            );
          expect(durableReassertion?.result).toMatchObject({ items: minimalResult });

          const [scheduledMembership] = yield* admin
            .select({ id: customerGroupMemberships.customerGroupMembershipId })
            .from(customerGroupMemberships)
            .where(
              and(
                eq(customerGroupMemberships.tenantId, tenantId),
                eq(customerGroupMemberships.customerProfileId, profileSource),
                eq(customerGroupMemberships.customerGroupId, partialGroupA),
              ),
            );
          expect(scheduledMembership).toBeDefined();
          const membershipId = scheduledMembership?.id ?? '';
          const scheduledEnd = date('2026-01-19T00:00:00.000Z');
          const conflictTime = '2026-01-18T12:00:00.000Z';
          const scheduled = yield* remove(
            membershipId,
            partialGroupA,
            profileSource,
            scheduledEnd,
            date('2026-01-18T00:00:00.000Z'),
            crypto.randomUUID(),
          );
          expect(scheduled.outcome).toBe('REMOVED');
          const beforeConflict = yield* readEffective(profileSource, date(conflictTime));
          const replacementGroup = yield* sourceGroup('REPLACEMENT');
          const conflictingComplete = {
            ...command('internal-e', 7, conflictTime),
            completenessProofRef: 'internal-scheduled-removal-conflict-proof',
            groupRefs: [groupRef(replacementGroup)],
            operation: 'COMPLETE',
          };
          yield* verifyComplete(conflictingComplete);
          expect(yield* runSource(sourceE, conflictingComplete)).toEqual({
            outcome: 'SOURCE_CONFLICT',
            result: null,
          });
          const conflictingRemove = {
            ...command('internal-e', 8, conflictTime),
            expectedRevision: scheduled.membership_json?.revision ?? 0,
            groupRef: groupRef(partialGroupA),
            membershipRef: {
              moduleId: 'commerce.customer-context',
              resourceId: membershipId,
              resourceType: 'commerce.customer-context.customer-group-membership',
              tenantId,
            },
            operation: 'REMOVE',
          };
          expect(yield* runSource(sourceE, conflictingRemove)).toEqual({
            outcome: 'SOURCE_CONFLICT',
            result: null,
          });
          expect(yield* readEffective(profileSource, date(conflictTime))).toEqual(beforeConflict);
          const afterScheduledEnd = yield* readEffective(profileSource, scheduledEnd);
          expect(afterScheduledEnd.items_json).toHaveLength(beforeConflict.items_json.length - 1);
          expect(afterScheduledEnd.items_json).not.toContainEqual(
            expect.objectContaining({ groupRef: groupRef(partialGroupA) }),
          );
          expect(afterScheduledEnd.items_json).toContainEqual(
            expect.objectContaining({ groupRef: groupRef(partialGroupB) }),
          );
          expect(
            yield* admin
              .select({ result: customerGroupMembershipSourceReceipts.result })
              .from(customerGroupMembershipSourceReceipts)
              .where(
                and(
                  eq(customerGroupMembershipSourceReceipts.tenantId, tenantId),
                  eq(customerGroupMembershipSourceReceipts.effectId, conflictingComplete.source.effectId),
                ),
              ),
          ).toHaveLength(0);

          const reconciliationCaseId = crypto.randomUUID();
          yield* admin.insert(profileReconciliationCases).values({
            actionInvocationId: crypto.randomUUID(),
            actorPrincipalId: principalId,
            canonicalizationEvidence: { fixture: true },
            canonicalPartyResourceId: 'internal-contract-party',
            collidingProfileId: profileRace,
            legalEntityId,
            mergeResourceId: 'internal-profile-collision',
            profileKind: 'RETAIL',
            profileReconciliationCaseId: reconciliationCaseId,
            sourceCorrelationRef: 'internal-contract-reconciliation',
            sourceProfileId: profileSource,
            targetSubject: { kind: 'RETAIL' },
            tenantId,
            trigger: 'IMPORT_CORRELATION',
          });
          yield* admin.execute(sql`
          insert into commerce_customer_context.profile_reconciliation_case_members (
            tenant_id, legal_entity_id, profile_reconciliation_case_id, customer_profile_id, member_position,
            observed_lifecycle
          ) values (${tenantId}, ${legalEntityId}, ${reconciliationCaseId}, ${profileSource}, 0, 'ACTIVE')
        `);
          expect(
            (yield* runSource(sourceE, {
              ...command('internal-e', 7, '2026-01-18T00:00:00.000Z'),
              groupRef: groupRef(eGroup),
              operation: 'ASSIGN',
            })).outcome,
          ).toBe('TARGET_INELIGIBLE');
        },
      );
      yield* proveSourceMembership();

      const replayInvocation = 'c7800000-0000-4000-8000-000000000001';
      const firstCreate = yield* createGroup('REPLAY', date('2026-01-01T00:00:00.000Z'), replayInvocation);
      const replayCreate = yield* createGroup('REPLAY', date('2026-01-01T00:00:00.000Z'), replayInvocation);
      expect(firstCreate.outcome).toBe('CREATED');
      expect(replayCreate.outcome).toBe('REUSED');
      expect(replayCreate.changed).toBe(false);
      expect(
        yield* admin
          .select({ id: customerGroups.customerGroupId })
          .from(customerGroups)
          .where(and(eq(customerGroups.tenantId, tenantId), eq(customerGroups.stableCode, 'GROUP_REPLAY'))),
      ).toHaveLength(1);
      expect(
        yield* admin
          .select({ id: customerGroupRevisions.customerGroupRevisionId })
          .from(customerGroupRevisions)
          .where(eq(customerGroupRevisions.actionInvocationId, replayInvocation)),
      ).toHaveLength(1);
      expect(
        yield* admin
          .select({ id: customerGroupLifecyclePeriods.customerGroupLifecyclePeriodId })
          .from(customerGroupLifecyclePeriods)
          .where(eq(customerGroupLifecyclePeriods.actionInvocationId, replayInvocation)),
      ).toHaveLength(1);
    }),
  ).pipe(Effect.provide(NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
);
