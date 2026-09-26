import { randomUUID } from 'node:crypto';

import { eq, inArray } from 'drizzle-orm';
import {
  OperationAuthenticationRequired,
  TrustedPrincipalContextSchema,
  changePrincipalBindingStatusAction,
  makeOperationalScopeRepository,
  makeOperationalScopeResolver,
} from '@app/core-runtime';
import type { ContextAccessService } from '@app/core-runtime';
import { AuthenticationNamespaceRegistrationSchema } from '@app/core-runtime/auth/external-identity-contracts';
import {
  AuthenticationNamespaceRegistry,
  TrustedAdmissionObservation,
  makeAuthenticationNamespaceRegistry,
  makeTrustedAuthenticationAdmissionService,
} from '@app/core-runtime/auth/external-identity-admission';
import type { TrustedAdmissionObservationService } from '@app/core-runtime/auth/external-identity-admission';
import { ExternalOperationAuthentication } from '@app/core-runtime/operations/external-authentication';
import { Clock, DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
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
} from '../../../../packages/core-runtime/src/db/schema.ts';
import { openActionRuntimeOptions } from '../../../../packages/core-runtime/tests/support/action-runtime-options.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { makeInMemoryTenantBindingIsolationOwner } from '../support/tenant-binding-isolation-fixture.ts';
import type {
  TenantBindingIsolationOwnerHttp,
  TenantBindingIsolationProviderState,
} from '../support/tenant-binding-isolation-fixture.ts';

const namespaceId = 'test.tenant-binding-isolation.provider';
const audience = 'shell-super-app.tenant-binding-isolation';
const attesterPrincipalId = '60000000-0000-4000-8000-000000000001';
const provider = 'better-auth';
const admissionNow = DateTime.makeUnsafe('2026-09-17T00:00:00.000Z');

const makeAdmissionClock = (initial: DateTime.Utc): Clock.Clock => {
  const currentMillis = DateTime.toEpochMillis(initial);
  return {
    currentTimeMillis: Effect.succeed(currentMillis),
    currentTimeMillisUnsafe: () => currentMillis,
    currentTimeNanos: Effect.succeed(BigInt(currentMillis) * 1_000_000n),
    currentTimeNanosUnsafe: () => BigInt(currentMillis) * 1_000_000n,
    monotonicTimeNanos: Effect.succeed(BigInt(currentMillis) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => BigInt(currentMillis) * 1_000_000n,
    sleep: () => Effect.void,
  };
};

const allowedContextResults = (keys: readonly string[]) =>
  Effect.succeed(keys.map((key) => ({ decision: 'allowed' as const, key })));

const actionContextAccess: ContextAccessService = {
  legalEntities: ({ legalEntityIds }) => allowedContextResults(legalEntityIds),
  modules: ({ moduleIds }) => allowedContextResults(moduleIds),
  resources: ({ resources }) =>
    allowedContextResults(
      resources.map(({ moduleId, resourceId, resourceType }) => `${moduleId}:${resourceType}:${resourceId}`),
    ),
  tenants: ({ tenantIds }) => allowedContextResults(tenantIds),
};

const makePrincipal = (input: {
  readonly authBindingId: string;
  readonly authContextRef: string;
  readonly principalId: string;
  readonly tenantId: string;
}) =>
  Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: input.authBindingId,
    authContextRef: input.authContextRef,
    authenticationNamespaceId: namespaceId,
    authMethod: 'session',
    principalId: input.principalId,
    tenantId: input.tenantId,
  });

const makeOwnerAuthentication = (
  owner: TenantBindingIsolationOwnerHttp,
  registry: ReturnType<typeof makeAuthenticationNamespaceRegistry>,
  providerCalls: { readonly authContextRef: string; readonly operation: string; readonly tenantId: string }[],
  providerSnapshots: TenantBindingIsolationProviderState[],
  operation: () => string,
) => {
  const trusted = makeTrustedAuthenticationAdmissionService({
    attesterPrincipalId,
    maxAdmissionWindowMillis: 5000,
  });
  const timeline = makeAdmissionClock(admissionNow);
  const authentication: typeof ExternalOperationAuthentication.Service = {
    verify: (request) =>
      Effect.gen(function* verifyOwnerAuthentication() {
        const observation = yield* owner.observeAuthentication(request);
        providerCalls.push({
          authContextRef: request.authContextRef,
          operation: operation(),
          tenantId: request.tenantId,
        });
        providerSnapshots.push(yield* owner.snapshot());
        const observer: TrustedAdmissionObservationService = {
          observeAuthentication: () => Effect.succeed(observation),
          observeExternalSubject: () => Effect.die('The bound isolation proof has no subject admission'),
        };
        return yield* trusted
          .verify({
            audience: request.audience,
            authBindingId: request.authBindingId,
            authContextRef: request.authContextRef,
            authenticationNamespaceId: request.authenticationNamespaceId,
            nonce: request.nonce,
            operationRef: request.operationRef,
            principalId: request.principalId,
            subjectType: request.subjectType,
            tenantId: request.tenantId,
          })
          .pipe(
            Effect.provideService(AuthenticationNamespaceRegistry, registry),
            Effect.provideService(TrustedAdmissionObservation, observer),
            Effect.provideService(Clock.Clock, timeline),
            Effect.mapError(
              () =>
                new OperationAuthenticationRequired({
                  code: 'operation_authentication_required',
                  reason: 'The owner did not admit the provider context',
                }),
            ),
          );
      }),
  };
  return authentication;
};

// This is the separable Core/PostgreSQL half of the isolation proof. The owner seam is deliberately
// public-contract shaped so a root17 HTTP composition can replace the fixture without changing the
// canonical recheck and durable-state assertions below.
it.live('revokes only T1 through the governed Core action and keeps T2 admitted on the same session', () =>
  Effect.gen(function* tenantBindingIsolation() {
    const { admin: adminClient, runtime } = yield* testDatabaseClients;
    const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
    const database = yield* makeTestDatabaseFromClient(runtime, coreRelations);
    const fixtureId = randomUUID();
    const tenantOneId = randomUUID();
    const tenantTwoId = randomUUID();
    const principalOneId = randomUUID();
    const principalTwoId = randomUUID();
    const bindingOneId = randomUUID();
    const bindingTwoId = randomUUID();
    const providerSubjectId = `provider-subject-${fixtureId}`;
    const providerSessionRef = `commerce-session:${fixtureId}`;
    const tenantOne = makePrincipal({
      authBindingId: bindingOneId,
      authContextRef: providerSessionRef,
      principalId: principalOneId,
      tenantId: tenantOneId,
    });
    const tenantTwo = makePrincipal({
      authBindingId: bindingTwoId,
      authContextRef: providerSessionRef,
      principalId: principalTwoId,
      tenantId: tenantTwoId,
    });
    const registry = makeAuthenticationNamespaceRegistry([
      Schema.decodeUnknownSync(AuthenticationNamespaceRegistrationSchema)({
        allowedAudiences: [audience],
        authenticationNamespaceId: namespaceId,
        provider,
        requiresOperationAdmission: true,
        reservationPrincipalKind: 'human',
        subjectTypes: ['user'],
        trustedAttesterPrincipalIds: [attesterPrincipalId],
      }),
    ]);
    const owner = makeInMemoryTenantBindingIsolationOwner({
      authenticationNamespaceId: namespaceId,
      businessGrantTenantIds: [tenantOneId, tenantTwoId],
      now: admissionNow,
      providerSubjectId,
      sessionRef: providerSessionRef,
    });
    const providerStateBefore = yield* owner.snapshot();
    const providerCalls: { readonly authContextRef: string; readonly operation: string; readonly tenantId: string }[] =
      [];
    const providerSnapshots: (typeof providerStateBefore)[] = [];
    let currentOperation = 'setup';
    const authentication = makeOwnerAuthentication(
      owner,
      registry,
      providerCalls,
      providerSnapshots,
      () => currentOperation,
    );
    const canonicalRepository = makeOperationalScopeRepository({ executor: database });
    const canonicalLoads: { readonly operation: string; readonly tenantId: string }[] = [];
    const scopeResolver = makeOperationalScopeResolver(
      {
        load: (principal) =>
          Effect.suspend(() => {
            canonicalLoads.push({ operation: currentOperation, tenantId: principal.tenantId });
            return canonicalRepository.load(principal);
          }),
      },
      actionContextAccess,
    );
    const actionRuntime = makeActionRuntime(
      { executor: database },
      makeActionRepository(),
      { checkActionPermission: () => Effect.succeed('allowed' as const) },
      scopeResolver,
      { ...openActionRuntimeOptions, contextAccess: actionContextAccess },
    );
    const cleanup = Effect.fnUntraced(function* cleanupTenantBindingIsolation() {
      yield* admin.delete(outboxMessages).where(inArray(outboxMessages.tenantId, [tenantOneId, tenantTwoId]));
      yield* admin.delete(domainEvents).where(inArray(domainEvents.tenantId, [tenantOneId, tenantTwoId]));
      yield* admin.delete(dataAccessEvents).where(inArray(dataAccessEvents.tenantId, [tenantOneId, tenantTwoId]));
      yield* admin.delete(auditEvents).where(inArray(auditEvents.tenantId, [tenantOneId, tenantTwoId]));
      yield* admin.delete(actionInvocations).where(inArray(actionInvocations.tenantId, [tenantOneId, tenantTwoId]));
      yield* admin
        .delete(principalAuthBindings)
        .where(inArray(principalAuthBindings.tenantId, [tenantOneId, tenantTwoId]));
      yield* admin.delete(principals).where(inArray(principals.tenantId, [tenantOneId, tenantTwoId]));
      yield* admin.delete(tenants).where(inArray(tenants.tenantId, [tenantOneId, tenantTwoId]));
    });
    yield* Effect.acquireRelease(Effect.void, () => cleanup().pipe(Effect.orDie));
    yield* cleanup();
    yield* admin.insert(tenants).values([
      {
        defaultLocale: 'en',
        name: 'Lane16 Tenant One',
        slug: `lane16-tenant-one-${fixtureId}`,
        status: 'active',
        tenantId: tenantOneId,
      },
      {
        defaultLocale: 'en',
        name: 'Lane16 Tenant Two',
        slug: `lane16-tenant-two-${fixtureId}`,
        status: 'active',
        tenantId: tenantTwoId,
      },
    ]);
    yield* admin.insert(principals).values([
      {
        displayName: 'Lane16 Tenant One Principal',
        kind: 'human',
        principalId: principalOneId,
        status: 'active',
        tenantId: tenantOneId,
      },
      {
        displayName: 'Lane16 Tenant Two Principal',
        kind: 'human',
        principalId: principalTwoId,
        status: 'active',
        tenantId: tenantTwoId,
      },
    ]);
    yield* admin.insert(principalAuthBindings).values([
      {
        authenticationNamespaceId: namespaceId,
        principalAuthBindingId: bindingOneId,
        principalId: principalOneId,
        provider,
        providerSubjectId,
        status: 'active',
        subjectType: 'user',
        tenantId: tenantOneId,
      },
      {
        authenticationNamespaceId: namespaceId,
        principalAuthBindingId: bindingTwoId,
        principalId: principalTwoId,
        provider,
        providerSubjectId,
        status: 'active',
        subjectType: 'user',
        tenantId: tenantTwoId,
      },
    ]);

    const resolveCurrent = (principal: typeof tenantOne, operation: string) =>
      Effect.suspend(() => {
        currentOperation = operation;
        return scopeResolver
          .resolve({
            audience,
            correlationId: `lane16-${operation}-${fixtureId}`,
            legalEntityScope: 'forbidden',
            principal,
          })
          .pipe(
            Effect.provideService(AuthenticationNamespaceRegistry, registry),
            Effect.provideService(ExternalOperationAuthentication, authentication),
            Effect.ensuring(Effect.sync(() => (currentOperation = 'idle'))),
          );
      });
    const revokeTenantOne = Effect.suspend(() => {
      currentOperation = 'revoke-t1';
      return actionRuntime
        .runAction({
          audience,
          payload: {
            authBindingId: bindingOneId,
            expectedRevision: 1,
            reason: 'Lane16 tenant-local isolation proof',
            requestedStatus: 'revoked',
          },
          principal: tenantOne,
          registration: changePrincipalBindingStatusAction,
          transport: {
            correlationId: `lane16-revoke-${fixtureId}`,
            idempotencyKey: `lane16-revoke-${fixtureId}`,
          },
        })
        .pipe(
          Effect.provideService(AuthenticationNamespaceRegistry, registry),
          Effect.provideService(ExternalOperationAuthentication, authentication),
          Effect.ensuring(Effect.sync(() => (currentOperation = 'idle'))),
        );
    });

    yield* resolveCurrent(tenantOne, 't1-before-revoke');
    yield* resolveCurrent(tenantTwo, 't2-before-revoke');
    const providerStateAtRevoke = yield* owner.snapshot();
    const revoked = yield* revokeTenantOne;
    expect(revoked.bindingStatus).toBe('revoked');
    expect(revoked.bindingRevision).toBe(2);
    const tenantOneDenied = yield* resolveCurrent(tenantOne, 't1-after-revoke').pipe(Effect.flip);
    expect(tenantOneDenied).toBeInstanceOf(OperationAuthenticationRequired);
    yield* resolveCurrent(tenantTwo, 't2-after-revoke');

    expect(canonicalLoads.filter(({ operation }) => operation === 't1-before-revoke')).toHaveLength(1);
    expect(canonicalLoads.filter(({ operation }) => operation === 't2-before-revoke')).toHaveLength(1);
    expect(canonicalLoads.filter(({ operation }) => operation === 'revoke-t1')).toHaveLength(1);
    expect(canonicalLoads.filter(({ operation }) => operation === 't1-after-revoke')).toHaveLength(1);
    expect(canonicalLoads.filter(({ operation }) => operation === 't2-after-revoke')).toHaveLength(1);
    expect(
      providerCalls.map(({ authContextRef, operation, tenantId }) => ({ authContextRef, operation, tenantId })),
    ).toEqual([
      { authContextRef: providerSessionRef, operation: 't1-before-revoke', tenantId: tenantOneId },
      { authContextRef: providerSessionRef, operation: 't2-before-revoke', tenantId: tenantTwoId },
      { authContextRef: providerSessionRef, operation: 'revoke-t1', tenantId: tenantOneId },
      { authContextRef: providerSessionRef, operation: 't1-after-revoke', tenantId: tenantOneId },
      { authContextRef: providerSessionRef, operation: 't2-after-revoke', tenantId: tenantTwoId },
    ]);
    expect(providerStateAtRevoke).toEqual(providerStateBefore);
    expect(yield* owner.snapshot()).toEqual(providerStateBefore);
    expect(providerSnapshots).toEqual(providerSnapshots.map(() => providerStateBefore));

    const persistedBindings = yield* admin
      .select({
        bindingRevision: principalAuthBindings.bindingRevision,
        status: principalAuthBindings.status,
        tenantId: principalAuthBindings.tenantId,
      })
      .from(principalAuthBindings)
      .where(inArray(principalAuthBindings.tenantId, [tenantOneId, tenantTwoId]));
    expect(persistedBindings.toSorted((left, right) => left.tenantId.localeCompare(right.tenantId))).toEqual(
      [
        { bindingRevision: 2, status: 'revoked', tenantId: tenantOneId },
        { bindingRevision: 1, status: 'active', tenantId: tenantTwoId },
      ].toSorted((left, right) => left.tenantId.localeCompare(right.tenantId)),
    );
    const pendingOutbox = yield* admin
      .select({ matchedAt: outboxMessages.matchedAt, topic: outboxMessages.topic })
      .from(outboxMessages)
      .where(eq(outboxMessages.tenantId, tenantOneId));
    expect(pendingOutbox).toHaveLength(1);
    expect(pendingOutbox[0]?.matchedAt).toBe(null);
  }),
);
