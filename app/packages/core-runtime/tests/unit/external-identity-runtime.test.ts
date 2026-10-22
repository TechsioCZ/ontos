import { v1 } from '@authzed/authzed-node';
import { runActionOwnerSteps } from '../../src/actions/definition.ts';
import { createActionCollector } from '../../src/actions/collector.ts';
import { principalBindingLifecycleDomainEvents } from '../../src/auth/external-identity/event.ts';
import { ExternalIdentityActionAuditEvidenceSchema } from '../../src/auth/external-identity/audit.ts';
import { AuthenticationNamespaceRegistry } from '../../src/auth/external-identity/verifier.ts';
import { AuthenticationNamespaceRegistrationSchema,
  ActivatePrincipalBindingPayloadSchema,
  ReservePrincipalBindingPayloadSchema,
  ChangePrincipalBindingStatusPayloadSchema,
  ActivatePrincipalBindingResultSchema,
  ChangePrincipalBindingStatusResultSchema,
  ReadPrincipalBindingResultSchema,
  ReservePrincipalBindingResultSchema } from '../../src/auth/external-identity-contracts.ts';
import { ContextAccess, makeContextAccess } from '../../src/permissions/context-access.ts';
import { insideDatabaseTransaction, refuseInsideDatabaseTransaction } from '../../src/db/transaction-io-guard.ts';
import type { ScopedTransactionExecutor } from '../../src/db/scoped-transaction.ts';
import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type {
  ChangeExternalIdentityStatusInput,
  ExternalIdentityAdmissionContext,
  ExternalIdentityRepositoryService,
} from '../../src/auth/external-identity/repository.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { trustResolvedSystemPrincipalContext } from '../../src/auth/system-principal-context-provenance.ts';
import { activatePrincipalBindingAction } from '../../src/modules/actions/activate-principal-binding.action.ts';
import { changePrincipalBindingStatusAction } from '../../src/modules/actions/change-principal-binding-status.action.ts';
import { reservePrincipalBindingAction } from '../../src/modules/actions/reserve-principal-binding.action.ts';

const tenantId = '30000000-0000-4000-8000-000000000001';
const principalId = '20000000-0000-4000-8000-000000000001';
const authBindingId = '10000000-0000-4000-8000-000000000001';
const activationTransitionRef = '60000000-0000-4000-8000-000000000001';
const namespaceId = 'test.third-provider.realm';
const subject = {
  authenticationNamespaceId: namespaceId,
  providerSubjectId: 'provider-user-1',
  subjectType: 'user' as const,
};
const principal = trustResolvedSystemPrincipalContext(
  Schema.decodeSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:external-identity:run:lifecycle',
    authMethod: 'system',
    principalId,
    tenantId,
  }),
);

const noAdmission = Option.none<ExternalIdentityAdmissionContext>();

const namespaceRegistration = Schema.decodeSync(AuthenticationNamespaceRegistrationSchema)({
  allowedAudiences: ['test.reserve'],
  authenticationNamespaceId: namespaceId,
  provider: 'test-provider',
  requiresOperationAdmission: false,
  reservationPrincipalKind: 'human',
  subjectTypes: ['user'],
  trustedAttesterPrincipalIds: [],
});
const provideNamespaceAccess = <Value, Failure, Requirements>(effect: Effect.Effect<Value, Failure, Requirements>) =>
  effect.pipe(
    Effect.provideService(AuthenticationNamespaceRegistry, {
      lookup: () =>
        refuseInsideDatabaseTransaction('module-transport', 'deployment namespace registry').pipe(
          Effect.as(Option.some(namespaceRegistration)),
        ),
    }),
    Effect.provideService(
      ContextAccess,
      makeContextAccess({
        checkBulkPermissions: (request) =>
          refuseInsideDatabaseTransaction('spicedb', 'namespace permission').pipe(
            Effect.as(
              v1.CheckBulkPermissionsResponse.create({
                pairs: request.items.map((item) =>
                  v1.CheckBulkPermissionsPair.create({
                    request: item,
                    response: {
                      item: v1.CheckBulkPermissionsResponseItem.create({
                        permissionship: v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION,
                      }),
                      oneofKind: 'item',
                    },
                  }),
                ),
              }),
            ),
          ),
        checkPermission: () => Effect.die('unexpected single permission RPC'),
        close: () => {},
      }),
    ),
  );
const ownerContext = <Services>(services: Services) => {
  const collector = createActionCollector(
    principalBindingLifecycleDomainEvents,
    'core.identity',
    { captureMode: 'metadata_only', policyKey: 'test.identity.access.v1' },
    ExternalIdentityActionAuditEvidenceSchema,
  );
  const rows = [
    {
      authBindingId,
      authenticationNamespaceId: namespaceId,
      bindingRevision: 1,
      bindingStatus: 'pending',
      createdByInvocationId: null,
      lastTransitionRef: null,
      principalId,
      principalKind: 'human',
      principalStatus: 'active',
      provider: 'test-provider',
      providerSubjectId: subject.providerSubjectId,
      revokedAt: null,
      subjectType: 'user',
      tenantId,
      tenantStatus: 'active',
    },
  ];
  // SAFETY: This owner-read fake implements only the select/join/limit path reached by namespace preparation.
  const transaction = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({ innerJoin: () => ({ where: () => ({ limit: () => Effect.succeed(rows) }) }) }),
      }),
    }),
  } as unknown as ScopedTransactionExecutor;
  return {
    collector,
    context: {
      ...collector,
      actionInvocationId: activationTransitionRef,
      compositionRevision: 'a'.repeat(64),
      scope: { ...principal, correlationId: 'external-identity-owner-steps' },
      services,
      transaction: <Value, Failure, Requirements>(
        use: (owner: ScopedTransactionExecutor) => Effect.Effect<Value, Failure, Requirements>,
      ) => use(transaction).pipe(insideDatabaseTransaction('test.identity-owner-read')),
    },
  };
};

it.effect('runs the neutral reservation Action and emits only a generated lifecycle event', () =>
  Effect.gen(function* reserveActionProgram() {
    const prepare: ExternalIdentityRepositoryService['prepare'] = (input) =>
      Effect.sync(() => {
        expect(input.subject).toEqual(subject);
        expect(input.displayName).toBe('Reserved display name');
        return {
          authBindingId,
          bindingRevision: 1,
          bindingStatus: 'pending' as const,
          outcome: 'RESERVED' as const,
          principalId,
        };
      });
    const { collector, context } = ownerContext({ admission: noAdmission, prepare });

    const result = yield* provideNamespaceAccess(
      runActionOwnerSteps(
        reservePrincipalBindingAction,
        yield* Schema.decodeEffect(ReservePrincipalBindingPayloadSchema)({
          ...subject,
          displayName: 'Reserved display name',
        }),
        context,
      ),
    );

    expect(yield* Schema.decodeUnknownEffect(ReservePrincipalBindingResultSchema)(result)).toEqual({
      authBindingId,
      bindingRevision: 1,
      bindingStatus: 'pending',
      outcome: 'RESERVED',
      principalId,
    });
    const committed = { evidence: collector.snapshot() };
    expect(committed?.evidence.domainEvents).toHaveLength(1);
    expect(committed?.evidence.outboxMessages).toHaveLength(1);
    expect(committed?.evidence.auditEvidence['operation']).toBe('reserve');
  }),
);

it.effect('returns an existing reservation without fabricating another lifecycle transition', () =>
  Effect.gen(function* existingReservationProgram() {
    const prepare: ExternalIdentityRepositoryService['prepare'] = () =>
      Effect.succeed({
        authBindingId,
        bindingRevision: 3,
        bindingStatus: 'disabled',
        outcome: 'EXISTING',
        principalId,
      });
    const { collector, context } = ownerContext({ admission: noAdmission, prepare });

    const result = yield* provideNamespaceAccess(
      runActionOwnerSteps(
        reservePrincipalBindingAction,
        yield* Schema.decodeEffect(ReservePrincipalBindingPayloadSchema)(subject),
        context,
      ),
    );

    expect(yield* Schema.decodeUnknownEffect(ReservePrincipalBindingResultSchema)(result)).toEqual({
      authBindingId,
      bindingRevision: 3,
      bindingStatus: 'disabled',
      outcome: 'EXISTING',
      principalId,
    });
    const committed = { evidence: collector.snapshot() };
    expect(committed?.evidence.domainEvents).toHaveLength(0);
    expect(committed?.evidence.outboxMessages).toHaveLength(0);
  }),
);

it.effect('activates a pending binding through the neutral Action and publishes revision two', () =>
  Effect.gen(function* activateActionProgram() {
    const activate: ExternalIdentityRepositoryService['activate'] = () =>
      Effect.succeed({
        authBindingId,
        authenticationNamespaceId: namespaceId,
        bindingRevision: 2,
        bindingStatus: 'active',
        changed: true,
        outcome: 'ACTIVATED',
        principalId,
        tenantId,
        transitionRef: activationTransitionRef,
      });
    const { collector, context } = ownerContext({ activate, admission: noAdmission });

    const result = yield* provideNamespaceAccess(
      runActionOwnerSteps(
        activatePrincipalBindingAction,
        yield* Schema.decodeEffect(ActivatePrincipalBindingPayloadSchema)({ authBindingId, expectedRevision: 1 }),
        context,
      ),
    );

    expect(yield* Schema.decodeUnknownEffect(ActivatePrincipalBindingResultSchema)(result)).toEqual({
      authBindingId,
      bindingRevision: 2,
      bindingStatus: 'active',
      outcome: 'ACTIVATED',
      principalId,
    });
    const committed = { evidence: collector.snapshot() };
    expect(committed?.evidence.domainEvents).toHaveLength(1);
    expect(committed?.evidence.outboxMessages).toHaveLength(1);
  }),
);

it.effect('treats repeat activation of the current binding as an event-free no-op', () =>
  Effect.gen(function* repeatActivationProgram() {
    const activate: ExternalIdentityRepositoryService['activate'] = () =>
      Effect.succeed({
        authBindingId,
        authenticationNamespaceId: namespaceId,
        bindingRevision: 2,
        bindingStatus: 'active',
        changed: false,
        outcome: 'ACTIVATED',
        principalId,
        tenantId,
        transitionRef: activationTransitionRef,
      });
    const { collector, context } = ownerContext({ activate, admission: noAdmission });

    const result = yield* provideNamespaceAccess(
      runActionOwnerSteps(
        activatePrincipalBindingAction,
        yield* Schema.decodeEffect(ActivatePrincipalBindingPayloadSchema)({ authBindingId, expectedRevision: 2 }),
        context,
      ),
    );

    expect(yield* Schema.decodeUnknownEffect(ActivatePrincipalBindingResultSchema)(result)).toEqual({
      authBindingId,
      bindingRevision: 2,
      bindingStatus: 'active',
      outcome: 'ACTIVATED',
      principalId,
    });
    const committed = { evidence: collector.snapshot() };
    expect(committed?.evidence.domainEvents).toHaveLength(0);
    expect(committed?.evidence.outboxMessages).toHaveLength(0);
    expect(committed?.evidence.auditEvidence['previousStatus']).toBe('active');
    expect(committed?.evidence.auditEvidence['transitionRef']).toBe(activationTransitionRef);
  }),
);

it('round-trips populated and legacy-absent read provenance through the strict public schema', () => {
  const found = {
    authBindingId,
    authenticationNamespaceId: namespaceId,
    bindingRevision: 2,
    bindingStatus: 'active' as const,
    originalInvocationId: activationTransitionRef,
    outcome: 'FOUND' as const,
    principalId,
    principalStatus: 'active' as const,
    tenantStatus: 'active' as const,
  };
  expect(Schema.decodeSync(ReadPrincipalBindingResultSchema)(found)).toEqual({
    ...found,
    originalInvocationId: Option.some(activationTransitionRef),
  });
  expect(Schema.decodeSync(ReadPrincipalBindingResultSchema)({ ...found, originalInvocationId: null })).toEqual({
    ...found,
    originalInvocationId: Option.none(),
  });
});

it.effect('keeps an administrative same-state status no-op stable and event-free', () =>
  Effect.gen(function* statusActionProgram() {
    const statusResults: ChangeExternalIdentityStatusInput[] = [];
    const changeStatus: ExternalIdentityRepositoryService['changeStatus'] = (input) =>
      Effect.sync(() => {
        statusResults.push(input);
        return statusResults.length === 1
          ? {
              authBindingId,
              authenticationNamespaceId: namespaceId,
              bindingRevision: 2,
              bindingStatus: 'disabled' as const,
              previousStatus: 'active' as const,
              principalId,
              tenantId,
              transitionRef: activationTransitionRef,
            }
          : {
              authBindingId,
              authenticationNamespaceId: namespaceId,
              bindingRevision: 2,
              bindingStatus: 'disabled' as const,
              previousStatus: 'disabled' as const,
              principalId,
              tenantId,
              transitionRef: activationTransitionRef,
            };
      });
    const firstSteps = ownerContext({ admission: noAdmission, changeStatus });
    const secondSteps = ownerContext({ admission: noAdmission, changeStatus });
    const first = yield* provideNamespaceAccess(
      runActionOwnerSteps(
        changePrincipalBindingStatusAction,
        yield* Schema.decodeEffect(ChangePrincipalBindingStatusPayloadSchema)({
          authBindingId,
          expectedRevision: 1,
          reason: 'administrative disable',
          requestedStatus: 'disabled',
        }),
        firstSteps.context,
      ),
    );
    const second = yield* provideNamespaceAccess(
      runActionOwnerSteps(
        changePrincipalBindingStatusAction,
        yield* Schema.decodeEffect(ChangePrincipalBindingStatusPayloadSchema)({
          authBindingId,
          expectedRevision: 2,
          reason: 'repeat current state',
          requestedStatus: 'disabled',
        }),
        secondSteps.context,
      ),
    );

    expect((yield* Schema.decodeUnknownEffect(ChangePrincipalBindingStatusResultSchema)(first)).transitionRef).toBe(
      activationTransitionRef,
    );
    expect((yield* Schema.decodeUnknownEffect(ChangePrincipalBindingStatusResultSchema)(second)).transitionRef).toBe(
      activationTransitionRef,
    );
    const committed = [firstSteps, secondSteps].map(({ collector }) => ({ evidence: collector.snapshot() }));
    expect(committed).toHaveLength(2);
    expect(committed[0]?.evidence.domainEvents).toHaveLength(1);
    expect(committed[0]?.evidence.outboxMessages).toHaveLength(1);
    expect(committed[1]?.evidence.domainEvents).toHaveLength(0);
    expect(committed[1]?.evidence.outboxMessages).toHaveLength(0);
    expect(statusResults).toHaveLength(2);
  }),
);
