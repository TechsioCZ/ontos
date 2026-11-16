import { loadDatabaseConnectionPair, TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { and, eq, sql } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Effect, Layer, Option, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { SymmyFixtureExecutionPlanSchema, SymmyPinnedJobPlanSchema } from '../../shared/domain/symmy-job-execution.ts';
import { SymmyJobNotificationPolicySchema } from '../../shared/domain/symmy-job-notification.ts';
import type { SymmyJobCompletionNotification } from '../../shared/domain/symmy-job-notification.ts';
import {
  SymmyJobRetentionPolicySchema,
  symmyJobIntentContentRef,
  symmyJobResourceRef,
} from '../../shared/domain/symmy-job-retention.ts';
import {
  symmyImportJobs,
  symmyIntegrationRelations,
  symmyJobEffects,
  symmyJobNotifications,
  symmyJobRetentionTombstones,
  symmySyncAdmissions,
  symmyJobRoutes,
} from '../../src/db/schema.ts';
import { symmyJobStoreFactory } from '../../src/persistence/symmy-job-store.ts';
import {
  SymmyJobNotificationStore,
  symmyJobNotificationStore,
} from '../../src/services/symmy-job-notification-store.ts';
import type { SymmyJobNotificationStoreService } from '../../src/services/symmy-job-notification-store.ts';
import { SymmyJobLifecycleStoreError } from '../../src/services/symmy-job-notification-store-error.ts';
import { makeSymmyJobNotificationService } from '../../src/services/symmy-job-notification.service.ts';
import { symmyJobRetentionStore } from '../../src/services/symmy-job-retention-store.ts';
import { defineDatabaseIdentityEnrollment } from '@app/core-runtime/db/database-identity-manifest';

const FIXTURE_DATABASE_IDENTITY_ENROLLMENT = defineDatabaseIdentityEnrollment([]);

const openDatabase = (connectionString: string) =>
  PgClient.makeClient({ url: Redacted.make(connectionString) }).pipe(
    Effect.flatMap((client) =>
      makeWithDefaults({ relations: symmyIntegrationRelations }).pipe(Effect.provideService(PgClient.PgClient, client)),
    ),
  );
const scopeFor = (tenantId: string, principalId: string): OperationalScope => ({
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: crypto.randomUUID(),
    authContextRef: 'better-auth-api-key:internal-lifecycle-fixture',
    authMethod: 'api_key',
    principalId,
    tenantId,
  }),
  audience: 'symmy-integration',
  correlationId: 'internal-lifecycle-fixture',
});

it.effect(
  'retains callback delivery across restart and purges private payloads without deleting the replay tombstone',
  () =>
    Effect.gen(function* verifyNativeLifecycle() {
      // INTERNAL_CONTRACT: this exercises actual owner lifecycle persistence, not external Symmy or mocked Privacy acceptance.
      const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
      const admin = yield* openDatabase(connections.admin.connectionString);
      const tenantId = crypto.randomUUID();
      const principalId = crypto.randomUUID();
      const routeId = crypto.randomUUID();
      const scope = scopeFor(tenantId, principalId);
      const whereTenant = eq(symmyJobRoutes.tenantId, tenantId);
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* cleanup() {
          yield* admin.delete(symmyJobRetentionTombstones).where(eq(symmyJobRetentionTombstones.tenantId, tenantId));
          yield* admin.delete(symmyJobNotifications).where(eq(symmyJobNotifications.tenantId, tenantId));
          yield* admin.delete(symmyJobEffects).where(eq(symmyJobEffects.tenantId, tenantId));
          yield* admin.delete(symmyImportJobs).where(eq(symmyImportJobs.tenantId, tenantId));
          yield* admin.delete(symmySyncAdmissions).where(eq(symmySyncAdmissions.tenantId, tenantId));
          yield* admin.delete(symmyJobRoutes).where(whereTenant);
        }).pipe(Effect.orDie),
      );
      yield* admin.insert(symmyJobRoutes).values({
        active: true,
        fixtureIds: ['internal-lifecycle'],
        fixturePlan: Schema.decodeUnknownSync(SymmyFixtureExecutionPlanSchema)({
          items: [
            {
              effects: [
                {
                  effectKey: 'party',
                  operation: {
                    entrypointKey: 'party.registry.create-party',
                    moduleId: 'party.registry',
                    schemaVersion: '1',
                  },
                },
              ],
              itemKey: 'row',
              source: {
                entityKind: 'CUSTOMER',
                issuerId: 'internal-issuer',
                sourceNamespace: 'internal-namespace',
                sourceRecordId: 'INTERNAL_SOURCE_EMAIL@example.test',
              },
            },
          ],
        }),
        lifecyclePolicy: { notificationRequested: true, policyId: 'internal-policy', revision: 'v1' },
        mappingVersion: 'v1',
        principalId,
        routeId,
        routeKey: 'customersBatch',
        routeRevision: 'v1',
        tenantId,
      });
      const reactivity = yield* Reactivity.Reactivity;
      // Every operation uses a fresh connection and scoped transaction; no in-process delivery state is reused.
      const transaction = <A, E>(
        run: (executor: ScopedTransactionExecutor) => Effect.Effect<A, E>,
        invocationScope: OperationalScope = scope,
      ) =>
        openDatabase(connections.runtime.connectionString).pipe(
          Effect.flatMap((database) =>
            database.transaction((tx) =>
              installOperationalScope(tx, invocationScope, FIXTURE_DATABASE_IDENTITY_ENROLLMENT).pipe(
                Effect.flatMap(run),
              ),
            ),
          ),
          Effect.scoped,
          Effect.provideService(Reactivity.Reactivity, reactivity),
        );
      const admissionRequest = {
        fixtureId: 'internal-lifecycle',
        idempotencyKey: 'internal-lifecycle-key',
        routeKey: 'customersBatch' as const,
      };
      const admitted = yield* transaction((executor) =>
        symmyJobStoreFactory(executor, scope).pipe(Effect.flatMap((store) => store.admit(admissionRequest))),
      );
      const [effect] = yield* admin.select().from(symmyJobEffects).where(eq(symmyJobEffects.jobId, admitted.jobId));
      expect(effect).toBeDefined();
      if (effect === undefined) {
        return;
      }
      const invocationId = crypto.randomUUID();
      const executorPrincipalId = crypto.randomUUID();
      const executorBindingIncarnation = crypto.randomUUID();
      const unsupportedBranchId = crypto.randomUUID();
      const receiptPins = {
        authContextRef: `job:integration.symmy.execute-symmy-job:run:${invocationId}`,
        executorBindingIncarnation,
        executorPrincipalId,
        originalInvocationId: invocationId,
        originalInvocationStatus: 'succeeded',
        requestHash: 'c'.repeat(64),
      };
      const olderPrivateEffect = {
        ...effect.effect,
        ...receiptPins,
        intent: { privateName: 'INTERNAL_PERSONAL_MARKER' },
        ref: {
          ...effect.effect.ref,
          occurrence: {
            ...effect.effect.ref.occurrence,
            record: {
              ...effect.effect.ref.occurrence.record,
              route: {
                ...effect.effect.ref.occurrence.record.route,
                integrationRouteId: 'INTERNAL_SOURCE_EMAIL@example.test',
              },
            },
          },
          originalTarget: {
            moduleId: effect.effect.ref.operation.moduleId,
            resourceId: crypto.randomUUID(),
            resourceType: 'party.email.alice.example',
            tenantId,
          },
        },
      };
      // Deliberately model a persisted older/private payload without making it a business acceptance claim.
      yield* admin
        .update(symmyJobEffects)
        .set({
          effect: sql`${JSON.stringify(olderPrivateEffect)}::jsonb`,
          outcome: {
            effectId: effect.effect.ref.effectId,
            owner: effect.effect.ref.operation.moduleId,
            status: 'accepted_change',
          },
          ownerInvocationId: invocationId,
          resolvedEffect: sql`${JSON.stringify(olderPrivateEffect)}::jsonb`,
          state: 'settled',
        })
        .where(eq(symmyJobEffects.effectId, effect.effectId));
      yield* admin
        .update(symmyImportJobs)
        .set({
          executionPlan: sql`jsonb_set(jsonb_set(jsonb_set(${symmyImportJobs.executionPlan},'{items,0,effects,0}',${JSON.stringify(olderPrivateEffect)}::jsonb),'{sourceRouteId}','"INTERNAL_SOURCE_EMAIL@example.test"'::jsonb),'{items,0,unsupportedBranches}',${JSON.stringify([{ branchId: unsupportedBranchId, branchKey: 'INTERNAL_PERSONAL_MARKER', kind: 'TaxHint' }])}::jsonb)`,
        })
        .where(eq(symmyImportJobs.jobId, admitted.jobId));
      const policy = Schema.decodeUnknownSync(SymmyJobNotificationPolicySchema)({
        authorization: 'internal-callback-token',
        initialBackoffMs: 3_600_000,
        maxAttempts: 3,
        maxBackoffMs: 86_400_000,
        policyId: 'internal-policy',
        recipientId: 'internal-recipient',
        recipientUrl: 'https://lifecycle.internal.test/completed',
        revision: 'v1',
        routeId,
        tenantId,
        timeoutMs: 1000,
      });
      const notification: SymmyJobCompletionNotification = {
        contract: 'INTERNAL_C14_NOTIFICATION_V1',
        event: 'symmy.import_job.completed',
        job: {
          id: admitted.jobId,
          items: [
            {
              effects: [
                {
                  effectId: effect.effect.ref.effectId,
                  owner: effect.effect.ref.operation.moduleId,
                  status: 'accepted_change',
                },
              ],
              itemId: effect.effect.itemId,
            },
          ],
          status: 'completed_all',
        },
      };
      const input = {
        notification,
        policy: { notificationRequested: true, policyId: policy.policyId, revision: policy.revision },
        routeId,
        tenantId,
      };
      const store: SymmyJobNotificationStoreService = {
        claim: (value: Parameters<ReturnType<typeof symmyJobNotificationStore>['claim']>[0]) =>
          transaction((executor) => symmyJobNotificationStore(executor).claim(value)).pipe(
            Effect.mapError((cause) =>
              Object.defineProperty(new SymmyJobLifecycleStoreError({ code: 'lifecycle_store_unavailable' }), 'cause', {
                value: cause,
              }),
            ),
          ),
        settle: (value: Parameters<ReturnType<typeof symmyJobNotificationStore>['settle']>[0]) =>
          transaction((executor) => symmyJobNotificationStore(executor).settle(value)).pipe(
            Effect.mapError((cause) =>
              Object.defineProperty(new SymmyJobLifecycleStoreError({ code: 'lifecycle_store_unavailable' }), 'cause', {
                value: cause,
              }),
            ),
          ),
      };
      const delivered: Request[] = [];
      const acceptedReceipts = new Set<string | null>();
      let fail = true;
      const notificationHttp = FetchHttpClient.layer.pipe(
        Layer.provide(
          Layer.succeed(FetchHttpClient.Fetch, async (resource, init) => {
            const request = new Request(resource, init);
            delivered.push(request);
            if (!fail) {
              acceptedReceipts.add(request.headers.get('idempotency-key'));
            }
            return new Response(null, { status: fail ? 503 : 204 });
          }),
        ),
      );
      const first = yield* makeSymmyJobNotificationService([policy])
        .deliver(input)
        .pipe(Effect.provideService(SymmyJobNotificationStore, store))
        .pipe(
          Effect.provide(notificationHttp),
          Effect.provideService(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' }),
        );
      const [pending] = yield* admin
        .select()
        .from(symmyJobNotifications)
        .where(eq(symmyJobNotifications.jobId, admitted.jobId));
      const dueAt = Option.getOrThrow(Option.fromNullishOr(pending)).nextAttemptAt.getTime();
      const wakeAtMs = first === 'delivered' || first === 'exhausted' ? 0 : first.wakeAtMs;
      expect(wakeAtMs).toBeGreaterThanOrEqual(dueAt);
      expect(wakeAtMs).toBeLessThanOrEqual(dueAt + 1);
      expect(
        yield* makeSymmyJobNotificationService([policy])
          .deliver(input)
          .pipe(
            Effect.provideService(SymmyJobNotificationStore, store),
            Effect.provide(notificationHttp),
            Effect.provideService(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' }),
          ),
      ).toEqual(first);
      expect(delivered).toHaveLength(1);
      yield* admin
        .update(symmyJobNotifications)
        .set({ nextAttemptAt: sql`clock_timestamp()-interval '1 second'` })
        .where(eq(symmyJobNotifications.jobId, admitted.jobId));
      fail = false;
      // INTERNAL receiver fixture: the recipient accepts, then the process loses its durable acknowledgement.
      const lostAcknowledgement = yield* makeSymmyJobNotificationService([policy])
        .deliver(input)
        .pipe(
          Effect.provideService(SymmyJobNotificationStore, {
            ...store,
            settle: () => Effect.fail(new SymmyJobLifecycleStoreError({ code: 'lifecycle_store_unavailable' })),
          }),
          Effect.provide(notificationHttp),
          Effect.provideService(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' }),
          Effect.flip,
        );
      expect(lostAcknowledgement).toMatchObject({ code: 'lifecycle_store_unavailable' });
      const busy = yield* makeSymmyJobNotificationService([policy])
        .deliver(input)
        .pipe(
          Effect.provideService(SymmyJobNotificationStore, store),
          Effect.provide(notificationHttp),
          Effect.provideService(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' }),
        );
      expect(busy).toMatchObject({ wakeAtMs: expect.any(Number) });
      expect(delivered).toHaveLength(2);
      yield* admin
        .update(symmyJobNotifications)
        .set({
          leaseUntil: sql`clock_timestamp()-interval '1 second'`,
          nextAttemptAt: sql`clock_timestamp()-interval '1 second'`,
        })
        .where(eq(symmyJobNotifications.jobId, admitted.jobId));
      expect(
        yield* makeSymmyJobNotificationService([policy])
          .deliver(input)
          .pipe(Effect.provideService(SymmyJobNotificationStore, store))
          .pipe(
            Effect.provide(notificationHttp),
            Effect.provideService(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' }),
          ),
      ).toBe('delivered');
      expect(
        yield* makeSymmyJobNotificationService([policy])
          .deliver(input)
          .pipe(Effect.provideService(SymmyJobNotificationStore, store))
          .pipe(
            Effect.provide(notificationHttp),
            Effect.provideService(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' }),
          ),
      ).toBe('delivered');
      expect(delivered).toHaveLength(3);
      const changedDestination = makeSymmyJobNotificationService([
        { ...policy, recipientUrl: new URL('https://foreign.internal.test/completed') },
      ]);
      const changed = yield* changedDestination
        .deliver(input)
        .pipe(
          Effect.provideService(SymmyJobNotificationStore, store),
          Effect.provide(notificationHttp),
          Effect.provideService(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' }),
          Effect.flip,
        );
      expect(changed).toMatchObject({ code: 'notification_conflict' });
      expect(delivered).toHaveLength(3);
      expect(
        yield* store.settle({
          claimToken: crypto.randomUUID(),
          delivered: false,
          jobId: admitted.jobId,
          retryable: true,
          version: 0,
        }),
      ).toEqual({ applied: false });

      expect(delivered[0]?.headers.get('idempotency-key')).toBe(delivered[1]?.headers.get('idempotency-key'));
      expect(delivered[1]?.headers.get('idempotency-key')).toBe(delivered[2]?.headers.get('idempotency-key'));
      expect(acceptedReceipts.size).toBe(1);
      expect(yield* Effect.promise(() => delivered[1]?.text() ?? Promise.resolve(''))).not.toContain(
        'INTERNAL_PERSONAL_MARKER',
      );
      const retentionPolicy = Schema.decodeUnknownSync(SymmyJobRetentionPolicySchema)({
        governanceLegalEntityId: crypto.randomUUID(),
        policyId: 'internal-policy',
        retentionMs: 1,
        revision: 'v1',
        routeId,
        targetLegalEntityId: null,
        tenantId,
      });
      // Legacy rows without a pin remain erasable only under exact, explicit current route policy + approval.
      yield* admin
        .update(symmyImportJobs)
        .set({ lifecyclePolicy: null })
        .where(eq(symmyImportJobs.jobId, admitted.jobId));
      const governanceScope = { ...scope, legalEntityId: retentionPolicy.governanceLegalEntityId };
      const authority = {
        authorityReceiptRef: 'internal-native-decision',
        authorityRevision: '1',
        contentScopeRef: symmyJobIntentContentRef(admitted.jobId),
        resourceRef: symmyJobResourceRef(admitted.jobId),
        status: 'CURRENT_APPROVED' as const,
      };
      const purge = (receipt = authority) =>
        transaction(
          (executor) =>
            symmyJobRetentionStore(executor).purge({
              authority: receipt,
              jobId: admitted.jobId,
              policy: retentionPolicy,
            }),
          governanceScope,
        );
      expect(yield* purge({ ...authority, resourceRef: symmyJobResourceRef(crypto.randomUUID()) })).toBe('BLOCKED');
      const [unattached] = yield* admin.select().from(symmyImportJobs).where(eq(symmyImportJobs.jobId, admitted.jobId));
      expect(unattached?.lifecyclePolicy).toBeNull();
      expect(
        yield* transaction(
          (executor) =>
            symmyJobRetentionStore(executor).purge({
              authority,
              jobId: admitted.jobId,
              policy: {
                ...retentionPolicy,
                routeId: Schema.decodeUnknownSync(SymmyJobRetentionPolicySchema.fields.routeId)(crypto.randomUUID()),
              },
            }),
          governanceScope,
        ),
      ).toBe('BLOCKED');
      expect(
        yield* transaction(
          (executor) =>
            symmyJobRetentionStore(executor).purge({ authority, jobId: admitted.jobId, policy: retentionPolicy }),
          {
            ...scope,
            legalEntityId: Schema.decodeUnknownSync(SymmyJobRetentionPolicySchema.fields.governanceLegalEntityId)(
              crypto.randomUUID(),
            ),
          },
        ),
      ).toBe('BLOCKED');
      expect(
        yield* transaction(
          (executor) =>
            symmyJobRetentionStore(executor).purge({
              authority,
              jobId: admitted.jobId,
              policy: { ...retentionPolicy, targetLegalEntityId: Option.some(retentionPolicy.governanceLegalEntityId) },
            }),
          governanceScope,
        ),
      ).toBe('BLOCKED');
      const metadata = yield* transaction((executor) => symmyJobRetentionStore(executor).load(admitted.jobId));
      expect(Option.isSome(metadata)).toBe(true);
      expect(yield* purge()).toBe('PURGED');
      expect(yield* purge()).toBe('ALREADY_PURGED');
      const [retained] = yield* admin.select().from(symmyImportJobs).where(eq(symmyImportJobs.jobId, admitted.jobId));
      const [retainedEffect] = yield* admin
        .select()
        .from(symmyJobEffects)
        .where(eq(symmyJobEffects.effectId, effect.effectId));
      const [tombstone] = yield* admin
        .select()
        .from(symmyJobRetentionTombstones)
        .where(
          and(
            eq(symmyJobRetentionTombstones.tenantId, tenantId),
            eq(symmyJobRetentionTombstones.jobId, admitted.jobId),
          ),
        );
      if (retained === undefined || retainedEffect === undefined) {
        throw new Error('Expected the minimal native job and effect receipts to remain after erasure');
      }
      expect(
        JSON.stringify([retained.executionPlan, retainedEffect.effect, retainedEffect.resolvedEffect]),
      ).not.toContain('INTERNAL_PERSONAL_MARKER');
      expect(retainedEffect).toMatchObject({ outcome: { status: 'accepted_change' }, ownerInvocationId: invocationId });
      expect(Schema.is(SymmyPinnedJobPlanSchema)(retained.executionPlan)).toBe(true);
      expect(
        JSON.stringify([retained.executionPlan, retainedEffect.effect, retainedEffect.resolvedEffect]),
      ).not.toContain('party.email.alice.example');
      expect(retainedEffect.effect).toMatchObject(receiptPins);
      expect(retainedEffect.resolvedEffect).toMatchObject(receiptPins);
      expect(retained.executionPlan).toMatchObject({
        items: [
          {
            unsupportedBranches: [
              { branchId: unsupportedBranchId, branchKey: `erased.${unsupportedBranchId}`, kind: 'TaxHint' },
            ],
          },
        ],
      });
      expect(retained.lifecyclePolicy).toMatchObject({
        policyId: retentionPolicy.policyId,
        revision: retentionPolicy.revision,
      });
      expect(tombstone).toMatchObject({ retainedEffectIds: expect.arrayContaining([effect.effectId]) });
      const replay = yield* transaction((executor) =>
        symmyJobStoreFactory(executor, scope).pipe(Effect.flatMap((ownerStore) => ownerStore.admit(admissionRequest))),
      );
      expect(replay.jobId).toBe(admitted.jobId);
      expect(replay.inserted).toBe(false);
      const [afterReplay] = yield* admin
        .select()
        .from(symmyImportJobs)
        .where(eq(symmyImportJobs.jobId, admitted.jobId));
      expect(JSON.stringify(afterReplay?.executionPlan)).not.toContain('INTERNAL_PERSONAL_MARKER');
      expect(
        JSON.stringify([afterReplay?.executionPlan, retainedEffect.effect, retainedEffect.resolvedEffect]),
      ).not.toContain('INTERNAL_SOURCE_EMAIL@example.test');
      const [registeredRoute] = yield* admin.select().from(symmyJobRoutes).where(eq(symmyJobRoutes.routeId, routeId));
      if (registeredRoute === undefined) {
        return;
      }
      const syncRouteId = crypto.randomUUID();
      yield* admin
        .insert(symmyJobRoutes)
        .values({ ...registeredRoute, routeId: syncRouteId, routeKey: 'customerGroupsBatch' });
      const syncAdmissionId = crypto.randomUUID();
      yield* admin.insert(symmySyncAdmissions).values({
        admissionId: syncAdmissionId,
        admittedAt: sql`clock_timestamp()-interval '1 second'`,
        executionPlan: sql`${JSON.stringify(retained.executionPlan)}::jsonb`,
        idempotencyDigest: 'a'.repeat(64),
        intentDigest: 'b'.repeat(64),
        lifecyclePolicy: null,
        mappingVersion: 'v1',
        principalId,
        routeId: syncRouteId,
        routeKey: 'customerGroupsBatch',
        routeRevision: 'v1',
        tenantId,
      });
      yield* admin
        .update(symmySyncAdmissions)
        .set({
          executionPlan: sql`jsonb_set(jsonb_set(${symmySyncAdmissions.executionPlan},'{items,0,effects,0,intent}','{"privateName":"INTERNAL_SYNC_PERSONAL_MARKER"}'::jsonb),'{items,0,effects,0,ref,occurrence,record,sourceRecordId}','"INTERNAL_SOURCE_EMAIL@example.test"'::jsonb)`,
        })
        .where(eq(symmySyncAdmissions.admissionId, syncAdmissionId));
      const syncPolicy = {
        ...retentionPolicy,
        routeId: Schema.decodeUnknownSync(SymmyJobRetentionPolicySchema.fields.routeId)(syncRouteId),
      };
      const syncResource = `integration.symmy.sync-admission:${syncAdmissionId}`;
      const syncAuthority = {
        ...authority,
        contentScopeRef: `${syncResource}#integration.symmy.job-intent`,
        resourceRef: syncResource,
      };
      expect(
        yield* transaction(
          (executor) =>
            symmyJobRetentionStore(executor).purge({
              authority: syncAuthority,
              jobId: syncAdmissionId,
              kind: 'SYNC',
              policy: syncPolicy,
            }),
          governanceScope,
        ),
      ).toBe('PURGED');
      const [retainedSync] = yield* admin
        .select()
        .from(symmySyncAdmissions)
        .where(eq(symmySyncAdmissions.admissionId, syncAdmissionId));
      expect(JSON.stringify(retainedSync?.executionPlan)).not.toContain('INTERNAL_SYNC_PERSONAL_MARKER');
      expect(JSON.stringify(retainedSync?.executionPlan)).not.toContain('INTERNAL_SOURCE_EMAIL@example.test');
      expect(retainedSync?.executionPlan).toMatchObject({ items: [{ effects: [receiptPins] }] });
      expect(retainedSync?.lifecyclePolicy).toMatchObject({
        policyId: syncPolicy.policyId,
        revision: syncPolicy.revision,
      });
      expect(retainedSync?.retentionReceipt?.authorityReceiptRef).toBe(authority.authorityReceiptRef);
      const jobs = yield* admin
        .select({ id: symmyImportJobs.jobId })
        .from(symmyImportJobs)
        .where(eq(symmyImportJobs.tenantId, tenantId));
      expect(jobs).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, Reactivity.layer))),
);
