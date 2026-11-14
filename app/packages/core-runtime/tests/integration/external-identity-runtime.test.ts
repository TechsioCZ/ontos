import { and, eq } from 'drizzle-orm';
import { NodeCrypto } from '@effect/platform-node';
import { Cause, Clock, Crypto, DateTime, Effect, Exit, Option, Predicate, Schema } from 'effect';
import type { PlatformError } from 'effect';
import { SqlError, UnknownError } from 'effect/sql/SqlError';
import { expect, it } from 'effect-rstest';

import { bindingSubjectRead, resolveExternalSubjectRead } from '../../src/auth/external-identity/read.ts';
import { ExternalIdentityAdmission } from '../../src/auth/external-identity/resolve.ts';
import { makeReadRuntime } from '../../src/reads/runtime.ts';
import { openModuleEntrypointGateway } from '../support/open-module-entrypoint-gateway.ts';
import { makeActionRepository } from '../../src/actions/repository.ts';
import { makeActionRuntime } from '../../src/actions/runtime.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import type { TrustedPrincipalContext } from '../../src/actions/principal-context.ts';
import { trustResolvedSystemPrincipalContext } from '../../src/auth/system-principal-context-provenance.ts';
import {
  AuthBindingIdSchema,
  AuthenticationAdmissionObservationSchema,
  AuthenticationNamespaceIdSchema,
  AuthenticationNamespaceRegistrationSchema,
  ExternalAuthenticationSubjectSchema,
  ExternalSubjectAdmissionObservationSchema,
  PrincipalIdSchema,
  TenantIdSchema,
} from '../../src/auth/external-identity-contracts.ts';
import type { AuthBindingStatusSchema } from '../../src/auth/external-identity-contracts.ts';
import { externalIdentityFailure } from '../../src/auth/external-identity/errors.ts';
import type { ExternalIdentityFailure } from '../../src/auth/external-identity/errors.ts';
import type {
  ChangeExternalIdentityStatusInput,
  ExternalIdentityAdmissionContext,
} from '../../src/auth/external-identity/repository.ts';
import {
  AuthenticationNamespaceRegistry,
  TrustedAdmissionObservation,
  makeAuthenticationNamespaceRegistry,
  makeTrustedAuthenticationAdmissionService,
  makeTrustedExternalSubjectAdmissionService,
} from '../../src/auth/external-identity/verifier.ts';
import type {
  AuthenticationNamespaceRegistryService,
  TrustedAdmissionObservationService,
} from '../../src/auth/external-identity/verifier.ts';
import { externalIdentityRepositoryFromTransaction } from '../../src/auth/external-identity/repository.ts';
import { loadDatabaseConfig } from '../../src/db/config.ts';
import { SHARED_RUNTIME_IDENTITY } from '../../src/db/database-identities.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';
import { installOperationalScope } from '../../src/db/scoped-transaction.ts';
import {
  actionInvocations,
  auditEvents,
  coreRelations,
  dataAccessEvents,
  domainEvents,
  outboxMessages,
  principalAuthBindings,
  principals,
  tenants,
} from '../../src/db/schema.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { writeTestTenantScopes } from '../../src/testing/tenant-access.ts';
import { bindFixedAccessGate } from '../support/fixed-access-gate.ts';
import { makeAuthority, makeCheck } from '../unit/access-decision-support.ts';
import { reservePrincipalBindingAction } from '../../src/modules/actions/reserve-principal-binding.action.ts';
import { testOperationalScopeResolver } from '../fixtures/operational-scope.ts';
import { openActionRuntimeOptions } from '../support/action-runtime-options.ts';
import { makeCoreDatabase } from '../../src/db/client.ts';
import { injectStatementFaults } from '../support/database-faults.ts';
import { makeTestDatabaseFromClient, testDatabaseClients } from '../support/database.ts';

const namespaceId = Schema.decodeSync(AuthenticationNamespaceRegistrationSchema.fields.authenticationNamespaceId)(
  'test.integration.provider',
);
const audience = 'test.integration.core';
const attesterPrincipalId = '60000000-0000-4000-8000-000000000001';
const registration = Schema.decodeSync(AuthenticationNamespaceRegistrationSchema)({
  allowedAudiences: [audience, 'test.integration.reserve'],
  authenticationNamespaceId: namespaceId,
  provider: 'test-provider',
  requiresOperationAdmission: false,
  reservationPrincipalKind: 'human',
  subjectTypes: ['user'],
  trustedAttesterPrincipalIds: [attesterPrincipalId],
});
const registry = makeAuthenticationNamespaceRegistry([registration]);
const admissionNow = DateTime.makeUnsafe('2026-09-17T00:00:00.000Z');

const makeAdmissionClock = (initial: DateTime.Utc) => {
  let currentMillis = DateTime.toEpochMillis(initial);
  const clock: Clock.Clock = {
    currentTimeMillis: Effect.sync(() => currentMillis),
    currentTimeMillisUnsafe: () => currentMillis,
    currentTimeNanos: Effect.sync(() => BigInt(currentMillis) * 1_000_000n),
    currentTimeNanosUnsafe: () => BigInt(currentMillis) * 1_000_000n,
    monotonicTimeNanos: Effect.sync(() => BigInt(currentMillis) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => BigInt(currentMillis) * 1_000_000n,
    sleep: () => Effect.void,
  };
  return { clock, set: (time: DateTime.Utc) => (currentMillis = DateTime.toEpochMillis(time)) };
};

const nextUuid = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());

const makeSubject = () =>
  nextUuid.pipe(
    Effect.map((subjectId) =>
      Schema.decodeSync(ExternalAuthenticationSubjectSchema)({
        authenticationNamespaceId: namespaceId,
        providerSubjectId: `provider-user-${subjectId}`,
        subjectType: 'user',
      }),
    ),
  );

const makeScope = (tenantId: string) =>
  Effect.all([nextUuid, nextUuid]).pipe(
    Effect.map(([principalId, correlationId]): OperationalScope => {
      const principal = Schema.decodeSync(TrustedPrincipalContextSchema)({
        authContextRef: 'job:external-identity-integration:run:lifecycle',
        authMethod: 'system',
        principalId,
        tenantId,
      });
      return { ...principal, correlationId };
    }),
  );

type ActionDatabase = Parameters<typeof makeActionRuntime>[0];

type BindingStatusTransitionTarget = Exclude<Schema.Schema.Type<typeof AuthBindingStatusSchema>, 'pending'>;

type TestCoreDatabase = Effect.Success<ReturnType<typeof makeTestDatabaseFromClient<typeof coreRelations>>>;

/** Seeds one tenant with tenant-scoped cleanup registered as a finalizer; reused across the tests below. */
const makeTenantFixture = (label: string) =>
  Effect.gen(function* seedExternalIdentityTenant() {
    const { admin: adminClient, runtime } = yield* testDatabaseClients;
    const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
    const database = yield* makeTestDatabaseFromClient(runtime, coreRelations);
    const tenantId = yield* Schema.decodeEffect(TenantIdSchema)(yield* nextUuid);
    const cleanup = Effect.gen(function* cleanupExternalIdentityFixtures() {
      yield* admin.delete(principalAuthBindings).where(eq(principalAuthBindings.tenantId, tenantId));
      yield* admin.delete(principals).where(eq(principals.tenantId, tenantId));
      yield* admin.delete(tenants).where(eq(tenants.tenantId, tenantId));
    });
    yield* Effect.acquireRelease(cleanup, () => cleanup.pipe(Effect.orDie));
    yield* admin.insert(tenants).values({
      defaultLocale: 'en',
      name: `External identity ${label} integration`,
      slug: `external-identity-${label}-${tenantId}`,
      status: 'active',
      tenantId,
    });
    return { admin, database, tenantId };
  });

const makeRunPrepare =
  (
    database: TestCoreDatabase,
    scope: OperationalScope,
    subject: Schema.Schema.Type<typeof ExternalAuthenticationSubjectSchema>,
    tenantId: Schema.Schema.Type<typeof TenantIdSchema>,
  ) =>
  (invocationId: string) =>
    database.transaction((transaction) =>
      installOperationalScope(transaction, scope, FIXTURE_DATABASE_IDENTITY_ENROLLMENT).pipe(
        Effect.flatMap((scopedTransaction) =>
          externalIdentityRepositoryFromTransaction(scopedTransaction, { registry }).prepare({
            invocationId,
            subject,
            tenantId,
          }),
        ),
      ),
    );

const systemActionPrincipal = (tenantId: string, principalId: string) =>
  trustResolvedSystemPrincipalContext(
    Schema.decodeSync(TrustedPrincipalContextSchema)({
      authContextRef: 'job:external-identity:run:integration',
      authMethod: 'system',
      principalId,
      tenantId,
    }),
  );

const withOutboxInsertFailure = (database: ActionDatabase): ActionDatabase => {
  const transaction: ActionDatabase['executor']['transaction'] = (operation) =>
    database.executor.transaction((currentTransaction) =>
      operation(currentTransaction).pipe(
        injectStatementFaults((statement) =>
          statement.startsWith('insert into "core"."outbox_messages"')
            ? Effect.fail(
                new SqlError({
                  reason: new UnknownError({
                    cause: new Error('Injected external identity outbox failure'),
                    message: 'Injected external identity outbox failure',
                  }),
                }),
              )
            : Effect.void,
        ),
      ),
    );
  const executor: ActionDatabase['executor'] = Object.assign(Object.create(database.executor), { transaction });
  return { executor };
};

const makeSubjectAdmission = (
  subject: Schema.Schema.Type<typeof ExternalAuthenticationSubjectSchema>,
  tenantId: Schema.Schema.Type<typeof TenantIdSchema>,
): Effect.Effect<
  ExternalIdentityAdmissionContext,
  ExternalIdentityFailure | PlatformError.PlatformError,
  Crypto.Crypto
> =>
  Effect.all([nextUuid, nextUuid]).pipe(
    Effect.flatMap(([nonce, operationId]) => {
      const observedAt = admissionNow;
      const timeline = makeAdmissionClock(observedAt);
      const request = {
        ...subject,
        audience: 'test.integration.reserve',
        authContextRef: 'opaque-provider-context',
        nonce,
        operationRef: `reactivate:${operationId}`,
        tenantId,
      };
      const observation = Schema.decodeSync(ExternalSubjectAdmissionObservationSchema)({
        ...request,
        expiresAt: DateTime.add(observedAt, { milliseconds: 5000 }),
        observedAt,
      });
      const observer: TrustedAdmissionObservationService = {
        observeAuthentication: () =>
          Effect.fail(externalIdentityFailure('identity_unavailable', 'unused bound observation')),
        observeExternalSubject: () => Effect.succeed(observation),
      };
      return makeTrustedExternalSubjectAdmissionService({
        attesterPrincipalId,
        maxAdmissionWindowMillis: 5000,
      })
        .admit(request)
        .pipe(
          Effect.provideService(AuthenticationNamespaceRegistry, registry),
          Effect.provideService(TrustedAdmissionObservation, observer),
          Effect.provideService(Clock.Clock, timeline.clock),
          Effect.map((admission) => ({
            admission,
            match: { expected: request, kind: 'subject' as const },
          })),
        );
    }),
  );

const makeBoundAdmission = (
  subject: Schema.Schema.Type<typeof ExternalAuthenticationSubjectSchema>,
  tenantId: Schema.Schema.Type<typeof TenantIdSchema>,
  authBindingId: string,
  principalId: string,
  bindingRevision: number,
): Effect.Effect<
  ExternalIdentityAdmissionContext,
  ExternalIdentityFailure | PlatformError.PlatformError,
  Crypto.Crypto
> =>
  Effect.all([nextUuid, nextUuid]).pipe(
    Effect.flatMap(([nonce, operationId]) => {
      const observedAt = admissionNow;
      const timeline = makeAdmissionClock(observedAt);
      const request = {
        audience,
        authBindingId: Schema.decodeSync(AuthBindingIdSchema)(authBindingId),
        authContextRef: 'opaque-provider-context',
        authenticationNamespaceId: subject.authenticationNamespaceId,
        nonce,
        operationRef: `resolve:${operationId}`,
        principalId: Schema.decodeSync(PrincipalIdSchema)(principalId),
        subjectType: subject.subjectType,
        tenantId,
      };
      const observation = Schema.decodeSync(AuthenticationAdmissionObservationSchema)({
        audience: request.audience,
        authBindingId: request.authBindingId,
        authContextRef: request.authContextRef,
        authenticationNamespaceId: request.authenticationNamespaceId,
        bindingRevision,
        expiresAt: DateTime.add(observedAt, { milliseconds: 5000 }),
        nonce: request.nonce,
        observedAt,
        operationRef: request.operationRef,
        principalId: request.principalId,
        tenantId: request.tenantId,
      });
      const observer: TrustedAdmissionObservationService = {
        observeAuthentication: () => Effect.succeed(observation),
        observeExternalSubject: () =>
          Effect.fail(externalIdentityFailure('identity_unavailable', 'unused pre-binding observation')),
      };
      return makeTrustedAuthenticationAdmissionService({
        attesterPrincipalId,
        maxAdmissionWindowMillis: 5000,
      })
        .verify(request)
        .pipe(
          Effect.provideService(AuthenticationNamespaceRegistry, registry),
          Effect.provideService(TrustedAdmissionObservation, observer),
          Effect.provideService(Clock.Clock, timeline.clock),
          Effect.map((admission) => ({
            admission,
            match: {
              expected: {
                audience: request.audience,
                authBindingId: request.authBindingId,
                authContextRef: request.authContextRef,
                authenticationNamespaceId: request.authenticationNamespaceId,
                bindingRevision,
                nonce: request.nonce,
                operationRef: request.operationRef,
                principalId: request.principalId,
                tenantId: request.tenantId,
              },
              kind: 'authentication' as const,
            },
          })),
        );
    }),
  );

const convergeNeutralReservationLifecycle = Effect.gen(function* externalIdentityLifecycleIntegration() {
  const { admin, database, tenantId } = yield* makeTenantFixture('lifecycle');
  const subject = yield* makeSubject();
  const scope = yield* makeScope(tenantId);

  const runPrepare = makeRunPrepare(database, scope, subject, tenantId);
  const [preparedA, preparedB] = yield* Effect.all([runPrepare(yield* nextUuid), runPrepare(yield* nextUuid)], {
    concurrency: 2,
  });
  expect(preparedA.authBindingId).toBe(preparedB.authBindingId);
  expect(preparedA.principalId).toBe(preparedB.principalId);
  expect(preparedA.bindingStatus).toBe('pending');
  expect(yield* admin.select().from(principals).where(eq(principals.tenantId, tenantId))).toHaveLength(1);
  expect(
    yield* admin.select().from(principalAuthBindings).where(eq(principalAuthBindings.tenantId, tenantId)),
  ).toHaveLength(1);

  const deniedRead = yield* database.transaction((transaction) =>
    installOperationalScope(transaction, scope, FIXTURE_DATABASE_IDENTITY_ENROLLMENT).pipe(
      Effect.flatMap((scopedTransaction) =>
        externalIdentityRepositoryFromTransaction(scopedTransaction, {
          authorizeReadNamespace: () =>
            Effect.fail(externalIdentityFailure('identity_forbidden', 'integration namespace read denied')),
          registry,
        }).read({
          authBindingId: preparedA.authBindingId,
          lookup: 'binding',
          tenantId,
        }),
      ),
    ),
  );
  expect(deniedRead.outcome).toBe('NOT_FOUND');

  const deniedSubjectRead = yield* database
    .transaction((transaction) =>
      installOperationalScope(transaction, scope, FIXTURE_DATABASE_IDENTITY_ENROLLMENT).pipe(
        Effect.flatMap((scopedTransaction) =>
          externalIdentityRepositoryFromTransaction(scopedTransaction, {
            authorizeReadNamespace: () =>
              Effect.fail(externalIdentityFailure('identity_forbidden', 'integration namespace read denied')),
            registry,
          }).read({
            authenticationNamespaceId: namespaceId,
            lookup: 'subject',
            providerSubjectId: subject.providerSubjectId,
            subjectType: subject.subjectType,
            tenantId,
          }),
        ),
      ),
    )
    .pipe(Effect.flip);
  expect(Predicate.isTagged(deniedSubjectRead, 'ExternalIdentityFailure')).toBe(true);
  if (Predicate.isTagged(deniedSubjectRead, 'ExternalIdentityFailure')) {
    expect(deniedSubjectRead.code).toBe('identity_forbidden');
  }

  const runActivate = (expectedRevision: number, invocationId: string) =>
    database.transaction((transaction) =>
      installOperationalScope(transaction, scope, FIXTURE_DATABASE_IDENTITY_ENROLLMENT).pipe(
        Effect.flatMap((scopedTransaction) =>
          externalIdentityRepositoryFromTransaction(scopedTransaction, { registry }).activate({
            authBindingId: preparedA.authBindingId,
            expectedRevision,
            invocationId,
            tenantId,
          }),
        ),
      ),
    );
  const activated = yield* runActivate(1, yield* nextUuid);
  expect(activated.bindingRevision).toBe(2);
  expect(activated.bindingStatus).toBe('active');

  const boundAdmission = yield* makeBoundAdmission(
    subject,
    tenantId,
    activated.authBindingId,
    activated.principalId,
    activated.bindingRevision,
  );
  const resolved = yield* database.transaction((transaction) =>
    installOperationalScope(transaction, scope, FIXTURE_DATABASE_IDENTITY_ENROLLMENT).pipe(
      Effect.flatMap((scopedTransaction) =>
        externalIdentityRepositoryFromTransaction(scopedTransaction, { registry }).resolve({
          admission: boundAdmission,
          subject,
          tenantId,
        }),
      ),
    ),
  );
  expect(resolved.authBindingId).toBe(preparedA.authBindingId);
  expect(resolved.principalId).toBe(preparedA.principalId);

  const staleActivation = yield* runActivate(1, yield* nextUuid).pipe(Effect.flip);
  expect(Predicate.isTagged(staleActivation, 'ExternalIdentityFailure')).toBe(true);
  if (Predicate.isTagged(staleActivation, 'ExternalIdentityFailure')) {
    expect(staleActivation.code).toBe('identity_conflict');
  }

  const runStatus = (
    expectedRevision: number,
    requestedStatus: BindingStatusTransitionTarget,
    invocationId: string,
    options?: Readonly<{
      readonly admission?: ExternalIdentityAdmissionContext;
      readonly reconciliationRef?: string;
    }>,
  ) =>
    database.transaction((transaction) =>
      installOperationalScope(transaction, scope, FIXTURE_DATABASE_IDENTITY_ENROLLMENT).pipe(
        Effect.flatMap((scopedTransaction) => {
          const baseStatusInput = {
            authBindingId: preparedA.authBindingId,
            expectedRevision,
            invocationId,
            reason: `integration ${requestedStatus}`,
            requestedStatus,
            tenantId,
          } satisfies Omit<ChangeExternalIdentityStatusInput, 'admission'>;
          const statusInput =
            options?.reconciliationRef === undefined
              ? baseStatusInput
              : { ...baseStatusInput, reconciliationRef: options.reconciliationRef };
          const admittedStatusInput =
            options?.admission === undefined ? statusInput : { ...statusInput, admission: options.admission };
          return externalIdentityRepositoryFromTransaction(scopedTransaction, { registry }).changeStatus(
            admittedStatusInput,
          );
        }),
      ),
    );
  const disabled = yield* runStatus(2, 'disabled', yield* nextUuid);
  expect(disabled.bindingRevision).toBe(3);
  const reactivationAdmission = yield* makeSubjectAdmission(subject, tenantId);
  const reactivated = yield* runStatus(3, 'active', yield* nextUuid, {
    admission: reactivationAdmission,
    reconciliationRef: 'integration-reconciliation-1',
  });
  expect(reactivated.bindingRevision).toBe(4);
  const revoked = yield* runStatus(4, 'revoked', yield* nextUuid);
  expect(revoked.bindingRevision).toBe(5);

  const revokedAdmission = yield* makeBoundAdmission(
    subject,
    tenantId,
    revoked.authBindingId,
    revoked.principalId,
    revoked.bindingRevision,
  );
  const revokedResolution = yield* database
    .transaction((transaction) =>
      installOperationalScope(transaction, scope, FIXTURE_DATABASE_IDENTITY_ENROLLMENT).pipe(
        Effect.flatMap((scopedTransaction) =>
          externalIdentityRepositoryFromTransaction(scopedTransaction, { registry }).resolve({
            admission: revokedAdmission,
            subject,
            tenantId,
          }),
        ),
      ),
    )
    .pipe(Effect.flip);
  expect(Predicate.isTagged(revokedResolution, 'ExternalIdentityFailure')).toBe(true);
  if (Predicate.isTagged(revokedResolution, 'ExternalIdentityFailure')) {
    expect(revokedResolution.code).toBe('identity_unusable');
  }

  const reReservation = yield* runPrepare(yield* nextUuid);
  expect(reReservation.outcome).toBe('EXISTING');
  expect(reReservation.bindingStatus).toBe('revoked');
  expect(reReservation.authBindingId).toBe(preparedA.authBindingId);
  expect(reReservation.principalId).toBe(preparedA.principalId);

  const finalBinding = yield* admin
    .select({ revision: principalAuthBindings.bindingRevision, status: principalAuthBindings.status })
    .from(principalAuthBindings)
    .where(
      and(
        eq(principalAuthBindings.tenantId, tenantId),
        eq(principalAuthBindings.principalAuthBindingId, preparedA.authBindingId),
      ),
    );
  expect(finalBinding[0]?.status).toBe('revoked');
  expect(finalBinding[0]?.revision).toBe(5);
  expect(yield* admin.select().from(principals).where(eq(principals.tenantId, tenantId))).toHaveLength(1);
});

const rollBackNeutralReservation = Effect.gen(function* externalIdentityRollbackIntegration() {
  const { admin, database, tenantId } = yield* makeTenantFixture('rollback');
  const subject = yield* makeSubject();
  const scope = yield* makeScope(tenantId);
  const invocationId = yield* nextUuid;

  const failure = yield* database
    .transaction((transaction) =>
      installOperationalScope(transaction, scope, FIXTURE_DATABASE_IDENTITY_ENROLLMENT).pipe(
        Effect.flatMap((scopedTransaction) =>
          externalIdentityRepositoryFromTransaction(scopedTransaction, { registry })
            .prepare({ invocationId, subject, tenantId })
            .pipe(Effect.andThen(Effect.fail(externalIdentityFailure('identity_unavailable', 'integration rollback')))),
        ),
      ),
    )
    .pipe(Effect.flip);
  expect(Predicate.isError(failure)).toBe(true);
  expect(yield* admin.select().from(principals).where(eq(principals.tenantId, tenantId))).toHaveLength(0);
  expect(
    yield* admin.select().from(principalAuthBindings).where(eq(principalAuthBindings.tenantId, tenantId)),
  ).toHaveLength(0);
});

const runGeneratedReservationThroughActionRuntime = Effect.scoped(
  Effect.gen(function* governedExternalIdentityActionIntegration() {
    const configuration = yield* loadDatabaseConfig({ identity: SHARED_RUNTIME_IDENTITY });
    const database = yield* makeCoreDatabase(configuration);
    const crypto = yield* Crypto.Crypto;
    const tenantId = yield* Schema.decodeEffect(TenantIdSchema)(yield* nextUuid);
    const actorPrincipalId = yield* Schema.decodeEffect(PrincipalIdSchema)(yield* nextUuid);
    const actor = systemActionPrincipal(tenantId, actorPrincipalId);
    const humanPrincipalId = yield* Schema.decodeEffect(PrincipalIdSchema)(yield* nextUuid);
    // A person is never admitted to a workload carrier, so this actor proves the refusal is real
    // rather than a missing grant (O59, O67-Q4).
    const humanAuthBindingId = yield* Schema.decodeEffect(AuthBindingIdSchema)(yield* nextUuid);
    const humanActor = yield* Schema.decodeEffect(TrustedPrincipalContextSchema)({
      authBindingId: humanAuthBindingId,
      authContextRef: 'better-auth-session:external-identity-negative-control',
      authMethod: 'session',
      principalId: humanPrincipalId,
      tenantId,
    });
    const successSubject = yield* makeSubject();
    const deniedSubject = yield* makeSubject();
    const namespaceDeniedSubject = yield* makeSubject();
    const rollbackSubject = yield* makeSubject();
    const cleanup = Effect.gen(function* cleanupGovernedActionFixtures() {
      for (const table of [
        outboxMessages,
        domainEvents,
        dataAccessEvents,
        auditEvents,
        actionInvocations,
        principalAuthBindings,
        principals,
      ]) {
        yield* database.executor.delete(table).where(eq(table.tenantId, tenantId));
      }
      // Core retains access intent (D27): the Tenant's scope and fence, and so the Tenant, stay.
    });
    yield* Effect.acquireRelease(cleanup, () => cleanup.pipe(Effect.orDie));
    yield* database.executor.insert(tenants).values({
      defaultLocale: 'en',
      name: 'External identity Action integration',
      slug: `external-identity-action-${tenantId}`,
      status: 'active',
      tenantId,
    });
    // The governed reservation runs under the Tenant's real access fence.
    yield* writeTestTenantScopes(database.executor, { principalId: actorPrincipalId, tenantId });
    yield* database.executor.insert(principals).values([
      {
        displayName: 'External identity Action actor',
        kind: 'system',
        principalId: actorPrincipalId,
        status: 'active',
        tenantId,
      },
      {
        displayName: 'External identity refusal control',
        kind: 'human',
        principalId: humanPrincipalId,
        status: 'active',
        tenantId,
      },
    ]);
    yield* database.executor.insert(principalAuthBindings).values({
      authenticationNamespaceId: namespaceId,
      principalAuthBindingId: humanAuthBindingId,
      principalId: humanPrincipalId,
      provider: 'better_auth',
      providerSubjectId: `refusal-control-${yield* nextUuid}`,
      status: 'active',
      subjectType: 'user',
      tenantId,
    });

    // The provisioning Action carries `accessWorkload`, so the gate admits only a trusted workload
    // and never a person (O29, O59, O67-Q4); the actor kind is read from `core.principals`. The
    // suite grants no capability: a workload path never asks for one. The actor's registered key is
    // the namespace this workload provisions in (O73), so the suite binds it explicitly.
    const authority = makeAuthority({ cells: [] });
    const accessGate = bindFixedAccessGate({
      authorityFor: () => authority.port,
      check: makeCheck({ authority: { cells: [] } }).port,
      executor: database.executor,
      workloads: { [actorPrincipalId]: ['core.identity-provider'] },
    });
    const runReserve = (
      runtime: ReturnType<typeof makeActionRuntime>,
      subject: Schema.Schema.Type<typeof ExternalAuthenticationSubjectSchema>,
      key: string,
      requestActor: TrustedPrincipalContext = actor,
    ) =>
      runtime
        .runAction({
          payload: { ...subject, displayName: 'Neutral reserved principal' },
          principal: requestActor,
          registration: reservePrincipalBindingAction,
          transport: {
            correlationId: `external-identity-action-${key}`,
            idempotencyKey: key,
            targetModuleKey: 'core.identity',
            targetResourceId: subject.providerSubjectId,
            targetResourceType: 'principal-auth-binding',
          },
        })
        .pipe(Effect.provideService(AuthenticationNamespaceRegistry, registry));

    const allowedRuntime = makeActionRuntime(
      database,
      makeActionRepository(crypto),
      { checkActionPermission: () => Effect.succeed('allowed' as const) },
      testOperationalScopeResolver,
      { ...openActionRuntimeOptions, accessDecision: accessGate },
    );
    const reserved = yield* runReserve(allowedRuntime, successSubject, 'external-identity-action-success');
    expect(reserved.outcome).toBe('RESERVED');
    const [successInvocation] = yield* database.executor
      .select()
      .from(actionInvocations)
      .where(eq(actionInvocations.idempotencyKey, 'external-identity-action-success'));
    expect(successInvocation?.status).toBe('succeeded');
    const [successAudit, successAccess, successEvent, successOutbox] = yield* Effect.all([
      database.executor
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.actionInvocationId, successInvocation?.actionInvocationId ?? '')),
      database.executor
        .select()
        .from(dataAccessEvents)
        .where(eq(dataAccessEvents.actionInvocationId, successInvocation?.actionInvocationId ?? '')),
      database.executor
        .select()
        .from(domainEvents)
        .where(eq(domainEvents.actionInvocationId, successInvocation?.actionInvocationId ?? '')),
      database.executor.select().from(outboxMessages).where(eq(outboxMessages.tenantId, tenantId)),
    ]);
    expect(successAudit.length).toBe(1);
    expect(successAccess.length).toBe(1);
    expect(successEvent.length).toBe(1);
    expect(successOutbox.length).toBe(1);

    // O59, O67-Q4: a person is refused by the workload carrier itself, before any owner rule runs.
    const humanDenied = yield* runReserve(
      allowedRuntime,
      deniedSubject,
      'external-identity-action-human-denied',
      humanActor,
    ).pipe(Effect.flip);
    expect(Predicate.isTagged(humanDenied, 'ActionPermissionDenied')).toBe(true);
    expect(
      yield* database.executor
        .select()
        .from(principalAuthBindings)
        .where(eq(principalAuthBindings.providerSubjectId, deniedSubject.providerSubjectId)),
    ).toHaveLength(0);

    // The namespace a workload provisions in must be registered deployment data (O62: no SpiceDB grant).
    const unregisteredNamespace = yield* Schema.decodeEffect(AuthenticationNamespaceIdSchema)(
      'test.integration.unregistered',
    );
    const unregisteredSubject = yield* Schema.decodeEffect(ExternalAuthenticationSubjectSchema)({
      authenticationNamespaceId: unregisteredNamespace,
      providerSubjectId: `provider-user-${yield* nextUuid}`,
      subjectType: 'user',
    });
    const unregistered = yield* runReserve(
      allowedRuntime,
      unregisteredSubject,
      'external-identity-action-unregistered-namespace',
    ).pipe(Effect.flip);
    expect(Predicate.isTagged(unregistered, 'ExternalIdentityError')).toBe(true);
    expect(
      yield* database.executor
        .select()
        .from(principalAuthBindings)
        .where(eq(principalAuthBindings.providerSubjectId, namespaceDeniedSubject.providerSubjectId)),
    ).toHaveLength(0);

    const rollbackRuntime = makeActionRuntime(
      withOutboxInsertFailure(database),
      makeActionRepository(crypto),
      { checkActionPermission: () => Effect.succeed('allowed' as const) },
      testOperationalScopeResolver,
      { ...openActionRuntimeOptions, accessDecision: accessGate },
    );
    const rollback = yield* Effect.exit(
      runReserve(rollbackRuntime, rollbackSubject, 'external-identity-action-outbox-failure'),
    );
    expect(
      Exit.isFailure(rollback) &&
        Option.exists(Cause.findErrorOption(rollback.cause), Predicate.isTagged('ActionTransactionError')),
      Exit.isFailure(rollback) ? Cause.pretty(rollback.cause) : 'success',
    ).toBe(true);
    const [rollbackInvocation] = yield* database.executor
      .select()
      .from(actionInvocations)
      .where(eq(actionInvocations.idempotencyKey, 'external-identity-action-outbox-failure'));
    expect(rollbackInvocation?.status).toBe('received');
    expect(
      yield* database.executor
        .select()
        .from(principalAuthBindings)
        .where(eq(principalAuthBindings.providerSubjectId, rollbackSubject.providerSubjectId)),
    ).toHaveLength(0);
    expect(
      yield* database.executor
        .select()
        .from(domainEvents)
        .where(eq(domainEvents.actionInvocationId, rollbackInvocation?.actionInvocationId ?? '')),
    ).toHaveLength(0);
    expect(
      yield* database.executor.select().from(outboxMessages).where(eq(outboxMessages.tenantId, tenantId)),
    ).toHaveLength(1);
    expect(
      yield* database.executor
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.actionInvocationId, rollbackInvocation?.actionInvocationId ?? '')),
    ).toHaveLength(0);
  }),
);

const rejectRevokedStatusTransitions = Effect.gen(function* revokedStatusTransitionIntegration() {
  const { admin, database, tenantId } = yield* makeTenantFixture('revoked-status');
  const subject = yield* makeSubject();
  const scope = yield* makeScope(tenantId);

  const runPrepare = makeRunPrepare(database, scope, subject, tenantId);
  const runActivate = (authBindingId: string, expectedRevision: number, invocationId: string) =>
    database.transaction((transaction) =>
      installOperationalScope(transaction, scope, FIXTURE_DATABASE_IDENTITY_ENROLLMENT).pipe(
        Effect.flatMap((scopedTransaction) =>
          externalIdentityRepositoryFromTransaction(scopedTransaction, { registry }).activate({
            authBindingId,
            expectedRevision,
            invocationId,
            tenantId,
          }),
        ),
      ),
    );
  const runStatus = (
    authBindingId: string,
    expectedRevision: number,
    requestedStatus: BindingStatusTransitionTarget,
    invocationId: string,
    options?: Readonly<{
      readonly admission?: ExternalIdentityAdmissionContext;
      readonly reconciliationRef?: string;
    }>,
  ) =>
    database.transaction((transaction) =>
      installOperationalScope(transaction, scope, FIXTURE_DATABASE_IDENTITY_ENROLLMENT).pipe(
        Effect.flatMap((scopedTransaction) => {
          const baseStatusInput = {
            authBindingId,
            expectedRevision,
            invocationId,
            reason: `revoked-status-integration ${requestedStatus}`,
            requestedStatus,
            tenantId,
          } satisfies Omit<ChangeExternalIdentityStatusInput, 'admission'>;
          const statusInput =
            options?.reconciliationRef === undefined
              ? baseStatusInput
              : { ...baseStatusInput, reconciliationRef: options.reconciliationRef };
          const admittedStatusInput =
            options?.admission === undefined ? statusInput : { ...statusInput, admission: options.admission };
          return externalIdentityRepositoryFromTransaction(scopedTransaction, { registry }).changeStatus(
            admittedStatusInput,
          );
        }),
      ),
    );

  // pending(1) -> active(2) -> disabled(3) -> active(4) -> revoked(5).
  const reserved = yield* runPrepare(yield* nextUuid);
  const activated = yield* runActivate(reserved.authBindingId, 1, yield* nextUuid);
  const disabled = yield* runStatus(reserved.authBindingId, activated.bindingRevision, 'disabled', yield* nextUuid);
  expect(disabled.bindingRevision).toBe(3);
  const reactivationAdmission = yield* makeSubjectAdmission(subject, tenantId);
  const reactivated = yield* runStatus(reserved.authBindingId, disabled.bindingRevision, 'active', yield* nextUuid, {
    admission: reactivationAdmission,
    reconciliationRef: 'revoked-status-reconciliation',
  });
  expect(reactivated.bindingRevision).toBe(4);
  const revoked = yield* runStatus(reserved.authBindingId, reactivated.bindingRevision, 'revoked', yield* nextUuid);
  expect(revoked.bindingRevision).toBe(5);
  expect(revoked.bindingStatus).toBe('revoked');

  const revokedToActive = yield* runStatus(
    reserved.authBindingId,
    revoked.bindingRevision,
    'active',
    yield* nextUuid,
  ).pipe(Effect.flip);
  expect(Predicate.isTagged(revokedToActive, 'ExternalIdentityFailure')).toBe(true);
  if (Predicate.isTagged(revokedToActive, 'ExternalIdentityFailure')) {
    expect(revokedToActive.code).toBe('identity_conflict');
  }

  const revokedToDisabled = yield* runStatus(
    reserved.authBindingId,
    revoked.bindingRevision,
    'disabled',
    yield* nextUuid,
  ).pipe(Effect.flip);
  expect(Predicate.isTagged(revokedToDisabled, 'ExternalIdentityFailure')).toBe(true);
  if (Predicate.isTagged(revokedToDisabled, 'ExternalIdentityFailure')) {
    expect(revokedToDisabled.code).toBe('identity_conflict');
  }

  const frozenRow = yield* admin
    .select({
      revision: principalAuthBindings.bindingRevision,
      revokedAt: principalAuthBindings.revokedAt,
      status: principalAuthBindings.status,
    })
    .from(principalAuthBindings)
    .where(
      and(
        eq(principalAuthBindings.tenantId, tenantId),
        eq(principalAuthBindings.principalAuthBindingId, reserved.authBindingId),
      ),
    );
  expect(frozenRow[0]?.status).toBe('revoked');
  expect(frozenRow[0]?.revision).toBe(revoked.bindingRevision);
  expect(frozenRow[0]?.revokedAt).not.toBeNull();

  const freshReservation = yield* runPrepare(yield* nextUuid);
  expect(freshReservation.outcome).toBe('EXISTING');
  expect(freshReservation.bindingStatus).toBe('revoked');
  expect(freshReservation.authBindingId).toBe(reserved.authBindingId);
  expect(freshReservation.principalId).toBe(reserved.principalId);
});

const preventIdentifierReuseTransfer = Effect.gen(function* identifierReuseIntegration() {
  const { admin, database, tenantId } = yield* makeTenantFixture('identifier-reuse');
  const sharedEmail = `reuse-${yield* nextUuid}@example.test`;
  const otherNamespaceId = yield* Schema.decodeEffect(
    AuthenticationNamespaceRegistrationSchema.fields.authenticationNamespaceId,
  )('test.integration.provider.other');
  const otherRegistration = yield* Schema.decodeEffect(AuthenticationNamespaceRegistrationSchema)({
    allowedAudiences: [audience, 'test.integration.reserve'],
    authenticationNamespaceId: otherNamespaceId,
    provider: 'test-provider-other',
    requiresOperationAdmission: false,
    reservationPrincipalKind: 'human',
    subjectTypes: ['user'],
    trustedAttesterPrincipalIds: [attesterPrincipalId],
  });
  const reuseRegistry = makeAuthenticationNamespaceRegistry([registration, otherRegistration]);
  const scope = yield* makeScope(tenantId);

  const runPrepareIn = (
    activeRegistry: AuthenticationNamespaceRegistryService,
    subject: Schema.Schema.Type<typeof ExternalAuthenticationSubjectSchema>,
    invocationId: string,
    displayName: string,
  ) =>
    database.transaction((transaction) =>
      installOperationalScope(transaction, scope, FIXTURE_DATABASE_IDENTITY_ENROLLMENT).pipe(
        Effect.flatMap((scopedTransaction) =>
          externalIdentityRepositoryFromTransaction(scopedTransaction, { registry: activeRegistry }).prepare({
            displayName,
            invocationId,
            subject,
            tenantId,
          }),
        ),
      ),
    );
  const runActivateIn = (
    activeRegistry: AuthenticationNamespaceRegistryService,
    authBindingId: string,
    expectedRevision: number,
    invocationId: string,
  ) =>
    database.transaction((transaction) =>
      installOperationalScope(transaction, scope, FIXTURE_DATABASE_IDENTITY_ENROLLMENT).pipe(
        Effect.flatMap((scopedTransaction) =>
          externalIdentityRepositoryFromTransaction(scopedTransaction, { registry: activeRegistry }).activate({
            authBindingId,
            expectedRevision,
            invocationId,
            tenantId,
          }),
        ),
      ),
    );
  const runStatusIn = (
    activeRegistry: AuthenticationNamespaceRegistryService,
    authBindingId: string,
    expectedRevision: number,
    requestedStatus: BindingStatusTransitionTarget,
    invocationId: string,
  ) =>
    database.transaction((transaction) =>
      installOperationalScope(transaction, scope, FIXTURE_DATABASE_IDENTITY_ENROLLMENT).pipe(
        Effect.flatMap((scopedTransaction) =>
          externalIdentityRepositoryFromTransaction(scopedTransaction, { registry: activeRegistry }).changeStatus({
            authBindingId,
            expectedRevision,
            invocationId,
            reason: `identifier-reuse-integration ${requestedStatus}`,
            requestedStatus,
            tenantId,
          }),
        ),
      ),
    );

  // 1. First subject in the primary namespace, carrying the shared email as its display name marker.
  const firstSubject = yield* makeSubject();
  const firstReserved = yield* runPrepareIn(registry, firstSubject, yield* nextUuid, sharedEmail);
  expect(firstReserved.outcome).toBe('RESERVED');

  // 2. A brand new providerSubjectId in the same namespace/tenant, same email: a NEW binding + NEW Principal.
  const secondSubject = yield* makeSubject();
  const secondReserved = yield* runPrepareIn(registry, secondSubject, yield* nextUuid, sharedEmail);
  expect(secondReserved.outcome).toBe('RESERVED');
  expect(secondReserved.authBindingId).not.toBe(firstReserved.authBindingId);
  expect(secondReserved.principalId).not.toBe(firstReserved.principalId);

  // 3. Revoke the second subject's binding, then reuse the identical providerSubjectId: EXISTING/revoked, never resurrected.
  const secondActivated = yield* runActivateIn(registry, secondReserved.authBindingId, 1, yield* nextUuid);
  const secondRevoked = yield* runStatusIn(
    registry,
    secondReserved.authBindingId,
    secondActivated.bindingRevision,
    'revoked',
    yield* nextUuid,
  );
  expect(secondRevoked.bindingStatus).toBe('revoked');
  const secondReusedReservation = yield* runPrepareIn(registry, secondSubject, yield* nextUuid, sharedEmail);
  expect(secondReusedReservation.outcome).toBe('EXISTING');
  expect(secondReusedReservation.bindingStatus).toBe('revoked');
  expect(secondReusedReservation.authBindingId).toBe(secondReserved.authBindingId);
  expect(secondReusedReservation.principalId).toBe(secondReserved.principalId);

  // 4. The same providerSubjectId as the FIRST subject, but in a different namespace, resolves to its own pair.
  const otherNamespaceSubject = yield* Schema.decodeEffect(ExternalAuthenticationSubjectSchema)({
    authenticationNamespaceId: otherNamespaceId,
    providerSubjectId: firstSubject.providerSubjectId,
    subjectType: 'user',
  });
  const otherNamespaceReserved = yield* runPrepareIn(
    reuseRegistry,
    otherNamespaceSubject,
    yield* nextUuid,
    sharedEmail,
  );
  expect(otherNamespaceReserved.outcome).toBe('RESERVED');
  expect(otherNamespaceReserved.authBindingId).not.toBe(firstReserved.authBindingId);
  expect(otherNamespaceReserved.principalId).not.toBe(firstReserved.principalId);

  const otherNamespaceReconfirmed = yield* runPrepareIn(
    reuseRegistry,
    otherNamespaceSubject,
    yield* nextUuid,
    sharedEmail,
  );
  expect(otherNamespaceReconfirmed.outcome).toBe('EXISTING');
  expect(otherNamespaceReconfirmed.authBindingId).toBe(otherNamespaceReserved.authBindingId);
  expect(otherNamespaceReconfirmed.principalId).toBe(otherNamespaceReserved.principalId);

  const finalRows = yield* admin
    .select({
      authBindingId: principalAuthBindings.principalAuthBindingId,
      namespace: principalAuthBindings.authenticationNamespaceId,
      principalId: principalAuthBindings.principalId,
      providerSubjectId: principalAuthBindings.providerSubjectId,
    })
    .from(principalAuthBindings)
    .where(eq(principalAuthBindings.tenantId, tenantId));
  expect(finalRows).toHaveLength(3);
  const distinctPrincipalIds = new Set(finalRows.map((row) => row.principalId));
  expect(distinctPrincipalIds.size).toBe(3);
});

const runCoreIdentitySubjectReads = Effect.gen(function* governedCoreIdentitySubjectReads() {
  const { admin, database, tenantId } = yield* makeTenantFixture('governed-subject-reads');
  const scope = yield* makeScope(tenantId);
  const subject = yield* makeSubject();
  yield* admin.insert(principals).values({
    displayName: 'Core identity subject Read actor',
    kind: 'system',
    principalId: scope.principalId,
    status: 'active',
    tenantId,
  });
  yield* Effect.addFinalizer(() =>
    admin.delete(dataAccessEvents).where(eq(dataAccessEvents.tenantId, tenantId)).pipe(Effect.orDie),
  );
  const prepared = yield* makeRunPrepare(database, scope, subject, tenantId)(yield* nextUuid);
  const invocationId = yield* nextUuid;
  const activated = yield* database.transaction((transaction) =>
    installOperationalScope(transaction, scope, FIXTURE_DATABASE_IDENTITY_ENROLLMENT).pipe(
      Effect.flatMap((scopedTransaction) =>
        externalIdentityRepositoryFromTransaction(scopedTransaction, { registry }).activate({
          authBindingId: prepared.authBindingId,
          expectedRevision: 1,
          invocationId,
          tenantId,
        }),
      ),
    ),
  );
  const runtime = makeReadRuntime(
    { executor: database },
    openModuleEntrypointGateway,
    testOperationalScopeResolver,
    {
      legalEntities: () => Effect.succeed([]),
      modules: () => Effect.succeed([]),
      resources: () => Effect.succeed([]),
      tenants: () => Effect.succeed([]),
    },
    {
      accessDecision: bindFixedAccessGate({
        authorityFor: () => makeAuthority({ cells: [] }).port,
        check: makeCheck({ authority: { cells: [] } }).port,
        executor: database,
        workloads: { [scope.principalId]: ['core.identity-provider'] },
      }),
      databaseIdentities: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
    },
  );
  const principal = systemActionPrincipal(tenantId, scope.principalId);
  const loadedSubject = yield* runtime.runRead({
    audience,
    input: { authBindingId: activated.authBindingId, authenticationNamespaceId: namespaceId },
    principal,
    registration: bindingSubjectRead,
    transport: { correlationId: scope.correlationId },
  });
  expect(loadedSubject).toEqual(subject);
  const admission = yield* makeBoundAdmission(
    subject,
    tenantId,
    activated.authBindingId,
    activated.principalId,
    activated.bindingRevision,
  );
  const resolved = yield* runtime
    .runRead({
      audience,
      input: subject,
      principal,
      registration: resolveExternalSubjectRead,
      transport: { correlationId: scope.correlationId },
    })
    .pipe(
      Effect.provideService(ExternalIdentityAdmission, admission),
      Effect.provideService(AuthenticationNamespaceRegistry, registry),
    );
  expect(resolved).toEqual({
    authBindingId: activated.authBindingId,
    authenticationNamespaceId: namespaceId,
    bindingRevision: activated.bindingRevision,
    bindingStatus: 'active',
    outcome: 'RESOLVED',
    principalId: activated.principalId,
    tenantId,
  });
  expect(yield* admin.select().from(dataAccessEvents).where(eq(dataAccessEvents.tenantId, tenantId))).toHaveLength(2);
});

it.layer(NodeCrypto.layer, { excludeTestServices: true })('external identity runtime', (suite) => {
  suite.effect(
    'runs both genuine Core identity subject Reads with trusted admission and durable evidence',
    () => runCoreIdentitySubjectReads,
  );
  suite.effect(
    'converges concurrent neutral reservations and protects the complete binding lifecycle',
    () => convergeNeutralReservationLifecycle,
  );
  suite.effect(
    'rolls back a neutral reservation as one transaction and leaves no Principal orphan',
    () => rollBackNeutralReservation,
  );
  suite.effect(
    'runs the generated reservation through ActionRuntime with atomic evidence and rollback',
    () => runGeneratedReservationThroughActionRuntime,
  );
  suite.effect(
    'rejects every changeStatus transition out of revoked and leaves the reservation frozen at revocation',
    () => rejectRevokedStatusTransitions,
  );
  suite.effect(
    'identifier reuse never transfers a binding across a new subject, a revoked subject, or a different namespace',
    () => preventIdentifierReuseTransfer,
  );
});
