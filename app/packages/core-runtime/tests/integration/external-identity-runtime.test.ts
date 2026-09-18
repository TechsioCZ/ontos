import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { Cause, Clock, DateTime, Effect, Exit, Option, Predicate, Schema } from 'effect';
import { SqlError, UnknownError } from 'effect/unstable/sql/SqlError';
import { expect, it } from 'effect-rstest';

import { makeActionRepository } from '../../src/actions/repository.ts';
import { makeActionRuntime } from '../../src/actions/runtime.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { trustResolvedSystemPrincipalContext } from '../../src/auth/system-principal-context-provenance.ts';
import {
  AuthBindingIdSchema,
  AuthenticationAdmissionObservationSchema,
  AuthenticationNamespaceRegistrationSchema,
  ExternalAuthenticationSubjectSchema,
  ExternalSubjectAdmissionObservationSchema,
  PrincipalIdSchema,
  TenantIdSchema,
} from '../../src/auth/external-identity-contracts.ts';
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
import type { TrustedAdmissionObservationService } from '../../src/auth/external-identity/verifier.ts';
import { externalIdentityRepositoryFromTransaction } from '../../src/auth/external-identity/repository.ts';
import { loadDatabaseConfig } from '../../src/db/config.ts';
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
import type { ContextAccessService } from '../../src/permissions/context-access.ts';
import { ContextAccess } from '../../src/permissions/context-access.ts';
import { reservePrincipalBindingAction } from '../../src/modules/actions/reserve-principal-binding.action.ts';
import { testOperationalScopeResolver } from '../fixtures/operational-scope.ts';
import { openActionRuntimeOptions } from '../support/action-runtime-options.ts';
import { makeFaultInjectableCoreDatabase, TestQueryHook } from '../support/database-faults.ts';
import { makeTestDatabaseFromPool, testDatabasePools } from '../support/database.ts';

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

const makeSubject = () =>
  Schema.decodeSync(ExternalAuthenticationSubjectSchema)({
    authenticationNamespaceId: namespaceId,
    providerSubjectId: `provider-user-${randomUUID()}`,
    subjectType: 'user',
  });

const makeScope = (tenantId: string): OperationalScope => {
  const principal = Schema.decodeSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:external-identity-integration:run:lifecycle',
    authMethod: 'system',
    principalId: randomUUID(),
    tenantId,
  });
  return { ...principal, correlationId: randomUUID() };
};

type ActionDatabase = Parameters<typeof makeActionRuntime>[0];

const allowedContextResults = (keys: readonly string[]) =>
  Effect.succeed(keys.map((key) => ({ decision: 'allowed' as const, key })));
const deniedContextResults = (keys: readonly string[]) =>
  Effect.succeed(keys.map((key) => ({ decision: 'denied' as const, key })));

const actionContextAccess: ContextAccessService = {
  identityNamespaces: ({ authenticationNamespaceIds }) => allowedContextResults(authenticationNamespaceIds),
  legalEntities: ({ legalEntityIds }) => allowedContextResults(legalEntityIds),
  modules: ({ moduleIds }) => allowedContextResults(moduleIds),
  resources: ({ resources }) =>
    allowedContextResults(
      resources.map(({ moduleId, resourceId, resourceType }) => `${moduleId}:${resourceType}:${resourceId}`),
    ),
  tenants: ({ tenantIds }) => allowedContextResults(tenantIds),
};

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
        Effect.provideService(TestQueryHook, (statement) =>
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
): Effect.Effect<ExternalIdentityAdmissionContext, ExternalIdentityFailure> => {
  const observedAt = admissionNow;
  const timeline = makeAdmissionClock(observedAt);
  const request = {
    ...subject,
    audience: 'test.integration.reserve',
    authContextRef: 'opaque-provider-context',
    nonce: randomUUID(),
    operationRef: `reactivate:${randomUUID()}`,
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
};

const makeBoundAdmission = (
  subject: Schema.Schema.Type<typeof ExternalAuthenticationSubjectSchema>,
  tenantId: Schema.Schema.Type<typeof TenantIdSchema>,
  authBindingId: string,
  principalId: string,
  bindingRevision: number,
): Effect.Effect<ExternalIdentityAdmissionContext, ExternalIdentityFailure> => {
  const observedAt = admissionNow;
  const timeline = makeAdmissionClock(observedAt);
  const request = {
    audience,
    authBindingId: Schema.decodeSync(AuthBindingIdSchema)(authBindingId),
    authContextRef: 'opaque-provider-context',
    authenticationNamespaceId: subject.authenticationNamespaceId,
    nonce: randomUUID(),
    operationRef: `resolve:${randomUUID()}`,
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
};

it.live('converges concurrent neutral reservations and protects the complete binding lifecycle', () =>
  Effect.gen(function* externalIdentityLifecycleIntegration() {
    const { admin: adminPool, runtimePool } = yield* testDatabasePools;
    const admin = yield* makeTestDatabaseFromPool(adminPool, coreRelations);
    const database = yield* makeTestDatabaseFromPool(runtimePool, coreRelations);
    const tenantId = yield* Schema.decodeEffect(TenantIdSchema)(randomUUID());
    const subject = makeSubject();
    const scope = makeScope(tenantId);
    const cleanup = Effect.gen(function* cleanupExternalIdentityFixtures() {
      yield* admin.delete(principalAuthBindings).where(eq(principalAuthBindings.tenantId, tenantId));
      yield* admin.delete(principals).where(eq(principals.tenantId, tenantId));
      yield* admin.delete(tenants).where(eq(tenants.tenantId, tenantId));
    });
    yield* Effect.acquireRelease(cleanup, () => cleanup.pipe(Effect.orDie));
    yield* admin.insert(tenants).values({
      defaultLocale: 'en',
      name: 'External identity lifecycle integration',
      slug: `external-identity-${tenantId}`,
      status: 'active',
      tenantId,
    });

    const runPrepare = (invocationId: string) =>
      database.transaction((transaction) =>
        installOperationalScope(transaction, scope).pipe(
          Effect.flatMap((scopedTransaction) =>
            externalIdentityRepositoryFromTransaction(scopedTransaction, { registry }).prepare({
              invocationId,
              subject,
              tenantId,
            }),
          ),
        ),
      );
    const [preparedA, preparedB] = yield* Effect.all([runPrepare(randomUUID()), runPrepare(randomUUID())], {
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
      installOperationalScope(transaction, scope).pipe(
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
        installOperationalScope(transaction, scope).pipe(
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
        installOperationalScope(transaction, scope).pipe(
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
    const activated = yield* runActivate(1, randomUUID());
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
      installOperationalScope(transaction, scope).pipe(
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

    const staleActivation = yield* runActivate(1, randomUUID()).pipe(Effect.flip);
    expect(Predicate.isTagged(staleActivation, 'ExternalIdentityFailure')).toBe(true);
    if (Predicate.isTagged(staleActivation, 'ExternalIdentityFailure')) {
      expect(staleActivation.code).toBe('identity_conflict');
    }

    const runStatus = (
      expectedRevision: number,
      requestedStatus: 'active' | 'disabled' | 'revoked',
      invocationId: string,
      options?: Readonly<{
        readonly admission?: ExternalIdentityAdmissionContext;
        readonly reconciliationRef?: string;
      }>,
    ) =>
      database.transaction((transaction) =>
        installOperationalScope(transaction, scope).pipe(
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
    const disabled = yield* runStatus(2, 'disabled', randomUUID());
    expect(disabled.bindingRevision).toBe(3);
    const reactivationAdmission = yield* makeSubjectAdmission(subject, tenantId);
    const reactivated = yield* runStatus(3, 'active', randomUUID(), {
      admission: reactivationAdmission,
      reconciliationRef: 'integration-reconciliation-1',
    });
    expect(reactivated.bindingRevision).toBe(4);
    const revoked = yield* runStatus(4, 'revoked', randomUUID());
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
        installOperationalScope(transaction, scope).pipe(
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

    const reReservation = yield* runPrepare(randomUUID());
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
  }),
);

it.live('rolls back a neutral reservation as one transaction and leaves no Principal orphan', () =>
  Effect.gen(function* externalIdentityRollbackIntegration() {
    const { admin: adminPool, runtimePool } = yield* testDatabasePools;
    const admin = yield* makeTestDatabaseFromPool(adminPool, coreRelations);
    const database = yield* makeTestDatabaseFromPool(runtimePool, coreRelations);
    const tenantId = yield* Schema.decodeEffect(TenantIdSchema)(randomUUID());
    const subject = makeSubject();
    const scope = makeScope(tenantId);
    const cleanup = Effect.gen(function* cleanupExternalIdentityRollbackFixtures() {
      yield* admin.delete(principalAuthBindings).where(eq(principalAuthBindings.tenantId, tenantId));
      yield* admin.delete(principals).where(eq(principals.tenantId, tenantId));
      yield* admin.delete(tenants).where(eq(tenants.tenantId, tenantId));
    });
    yield* Effect.acquireRelease(cleanup, () => cleanup.pipe(Effect.orDie));
    yield* admin.insert(tenants).values({
      defaultLocale: 'en',
      name: 'External identity rollback integration',
      slug: `external-identity-rollback-${tenantId}`,
      status: 'active',
      tenantId,
    });

    const failure = yield* database
      .transaction((transaction) =>
        installOperationalScope(transaction, scope).pipe(
          Effect.flatMap((scopedTransaction) =>
            externalIdentityRepositoryFromTransaction(scopedTransaction, { registry })
              .prepare({ invocationId: randomUUID(), subject, tenantId })
              .pipe(
                Effect.andThen(Effect.fail(externalIdentityFailure('identity_unavailable', 'integration rollback'))),
              ),
          ),
        ),
      )
      .pipe(Effect.flip);
    expect(Predicate.isError(failure)).toBe(true);
    expect(yield* admin.select().from(principals).where(eq(principals.tenantId, tenantId))).toHaveLength(0);
    expect(
      yield* admin.select().from(principalAuthBindings).where(eq(principalAuthBindings.tenantId, tenantId)),
    ).toHaveLength(0);
  }),
);

it.live('runs the generated reservation through ActionRuntime with atomic evidence and rollback', () =>
  Effect.scoped(
    Effect.gen(function* governedExternalIdentityActionIntegration() {
      const configuration = yield* loadDatabaseConfig();
      const database = yield* makeFaultInjectableCoreDatabase(configuration);
      const tenantId = yield* Schema.decodeEffect(TenantIdSchema)(randomUUID());
      const actorPrincipalId = yield* Schema.decodeEffect(PrincipalIdSchema)(randomUUID());
      const actor = systemActionPrincipal(tenantId, actorPrincipalId);
      const successSubject = makeSubject();
      const deniedSubject = makeSubject();
      const namespaceDeniedSubject = makeSubject();
      const rollbackSubject = makeSubject();
      const cleanup = Effect.gen(function* cleanupGovernedActionFixtures() {
        for (const table of [
          outboxMessages,
          domainEvents,
          dataAccessEvents,
          auditEvents,
          actionInvocations,
          principalAuthBindings,
          principals,
          tenants,
        ]) {
          yield* database.executor.delete(table).where(eq(table.tenantId, tenantId));
        }
      });
      yield* Effect.acquireRelease(cleanup, () => cleanup.pipe(Effect.orDie));
      yield* database.executor.insert(tenants).values({
        defaultLocale: 'en',
        name: 'External identity Action integration',
        slug: `external-identity-action-${tenantId}`,
        status: 'active',
        tenantId,
      });
      yield* database.executor.insert(principals).values({
        displayName: 'External identity Action actor',
        kind: 'system',
        principalId: actorPrincipalId,
        status: 'active',
        tenantId,
      });

      const runReserve = (
        runtime: ReturnType<typeof makeActionRuntime>,
        subject: Schema.Schema.Type<typeof ExternalAuthenticationSubjectSchema>,
        key: string,
        contextAccess: ContextAccessService = actionContextAccess,
      ) =>
        runtime
          .runAction({
            payload: { ...subject, displayName: 'Neutral reserved principal' },
            principal: actor,
            registration: reservePrincipalBindingAction,
            transport: {
              correlationId: `external-identity-action-${key}`,
              idempotencyKey: key,
              targetModuleKey: 'core.identity',
              targetResourceId: subject.providerSubjectId,
              targetResourceType: 'principal-auth-binding',
            },
          })
          .pipe(
            Effect.provideService(AuthenticationNamespaceRegistry, registry),
            Effect.provideService(ContextAccess, contextAccess),
          );

      const allowedRuntime = makeActionRuntime(
        database,
        makeActionRepository(),
        { checkActionPermission: () => Effect.succeed('allowed' as const) },
        testOperationalScopeResolver,
        openActionRuntimeOptions,
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

      const deniedRuntime = makeActionRuntime(
        database,
        makeActionRepository(),
        { checkActionPermission: () => Effect.succeed('denied' as const) },
        testOperationalScopeResolver,
        openActionRuntimeOptions,
      );
      const denied = yield* runReserve(deniedRuntime, deniedSubject, 'external-identity-action-denied').pipe(
        Effect.flip,
      );
      expect(Predicate.isTagged(denied, 'ActionPermissionDenied')).toBe(true);
      expect(
        yield* database.executor
          .select()
          .from(principalAuthBindings)
          .where(eq(principalAuthBindings.providerSubjectId, deniedSubject.providerSubjectId)),
      ).toHaveLength(0);

      const namespaceDeniedContextAccess: ContextAccessService = {
        ...actionContextAccess,
        identityNamespaces: ({ authenticationNamespaceIds }) => deniedContextResults(authenticationNamespaceIds),
      };
      const namespaceDenied = yield* runReserve(
        allowedRuntime,
        namespaceDeniedSubject,
        'external-identity-action-namespace-denied',
        namespaceDeniedContextAccess,
      ).pipe(Effect.flip);
      expect(Predicate.isTagged(namespaceDenied, 'ExternalIdentityError')).toBe(true);
      expect(
        yield* database.executor
          .select()
          .from(principalAuthBindings)
          .where(eq(principalAuthBindings.providerSubjectId, namespaceDeniedSubject.providerSubjectId)),
      ).toHaveLength(0);

      const rollbackRuntime = makeActionRuntime(
        withOutboxInsertFailure(database),
        makeActionRepository(),
        { checkActionPermission: () => Effect.succeed('allowed' as const) },
        testOperationalScopeResolver,
        openActionRuntimeOptions,
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
  ),
);
