import { and, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { Context, Crypto, DateTime, Effect, Layer, Option } from 'effect';

import type { TrustedPrincipalContext } from '../actions/principal-context.ts';
import { recoverSqlTransactionError } from '../actions/repository.ts';
import {
  AuthBindingIdSchema,
  AuthenticationNamespaceIdSchema,
  PrincipalIdSchema,
  TenantIdSchema,
} from '../auth/external-identity-contracts.ts';
import { assertAuthenticationAdmission, AuthenticationNamespaceRegistry } from '../auth/external-identity/verifier.ts';
import {
  isTrustedSupportRecoveryPrincipalContext,
  isTrustedSystemPrincipalContext,
  preserveSystemPrincipalContextTrust,
  readVerifiedGatewayScopeAssertion,
  readVerifiedGatewayWorkload,
  readVerifiedGatewayRouteScope,
} from '../auth/system-principal-context-provenance.ts';
import { CoreDatabase } from '../db/client.ts';
import { DatabaseIdentityEnrollmentContext, gatewayScopeGrantRoleForAudience } from '../db/database-identities.ts';
import type { DatabaseIdentityEnrollment } from '../db/database-identity-manifest.ts';
import { installOperationalScope } from '../db/scoped-transaction.ts';
import { auditEvents, legalEntities, principalAuthBindings, principals, tenants } from '../db/schema.ts';
import type { CoreDatabaseExecutor, CoreTransaction } from '../db/types.ts';
import { decodeProtectedAccessDeclaration } from '../authorization/access-declaration.ts';
import { recordSupportImpersonationAction } from '../modules/actions/record-support-impersonation.action.ts';
import type { BoundAccessGate } from './access-gate.ts';
import { bindLiveAccessGate } from './access-gate.ts';
import type { OperationContextError } from './errors.ts';
import {
  OperationAuthenticationRequired,
  OperationContextDenied,
  OperationContextInvalid,
  OperationContextUnavailable,
} from './errors.ts';
import type { OperationalScopeRepository, PersistedScopeRecord } from './repository-context.ts';
import { OperationalScopeRepositoryContext } from './repository-context.ts';
import { ExternalOperationAuthentication } from './external-authentication.ts';
import type { ExternalOperationAuthenticationRequest } from './external-authentication.ts';
import type { LegalEntityScope } from './legal-entity-scope.ts';

export type { OperationalScopeRepository } from './repository-context.ts';

const withOptionalProperty = <Base extends object, Key extends PropertyKey, Value, Trailing extends object>(
  base: Base,
  condition: boolean,
  key: Key,
  value: Value,
  trailing: Trailing,
) => (condition ? { ...base, [key]: value, ...trailing } : { ...base, ...trailing });

export interface OperationalScopeRequest {
  /** Receiver audience used to bind an external admission to this call. */
  readonly audience?: string;
  readonly correlationId: string;
  readonly traceId?: string;
}

export interface OperationalScope extends Readonly<TrustedPrincipalContext>, Readonly<OperationalScopeRequest> {}

/**
 * The two authority questions a scope resolution asks (O28): is this administrator still allowed to
 * impersonate, and may this person select the selected company. Both are the one access gate's
 * questions, bound to this composition's enforcement ports so a scope resolution carries no service
 * requirement of its own (CUTOVER-PLAN §3.1).
 */
export type OperationalScopeAccess = Pick<BoundAccessGate, 'decide' | 'selectableLegalEntities'>;

export interface ResolveOperationalScopeInput extends Readonly<OperationalScopeRequest> {
  readonly legalEntityScope: LegalEntityScope;
  readonly principal: TrustedPrincipalContext;
}

export interface OperationalScopeResolverService {
  readonly resolve: (input: ResolveOperationalScopeInput) => Effect.Effect<OperationalScope, OperationContextError>;
}

export class OperationalScopeResolver extends Context.Service<
  OperationalScopeResolver,
  OperationalScopeResolverService
>()('@app/core-runtime/operations/context/OperationalScopeResolver') {}

const operationContextUnavailable = (cause?: unknown) => {
  const failure = new OperationContextUnavailable({
    code: 'operation_context_unavailable',
    reason: 'The operation context could not be revalidated',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', {
      configurable: true,
      value: cause,
    });
  }
  return failure;
};

/**
 * A verified gateway principal resolves through a request role whose Core identity rows are
 * tenant-bound by row-level security. Its lookup runs after the database derives the scope from the
 * redeemed assertion, so it can read only the assertion's own tenant.
 */
const selectPersistedScope = <Row, E>(
  database: { readonly executor: Pick<CoreDatabaseExecutor, 'select' | 'transaction'> },
  principal: TrustedPrincipalContext,
  enrollment: DatabaseIdentityEnrollment,
  select: (executor: Pick<CoreTransaction, 'select'>) => Effect.Effect<readonly Row[], E>,
) =>
  Effect.suspend(() =>
    readVerifiedGatewayScopeAssertion(principal) === undefined
      ? select(database.executor)
      : database.executor.transaction((transaction) =>
          installOperationalScope(
            transaction,
            preserveSystemPrincipalContextTrust(principal, { ...principal, correlationId: '' }),
            enrollment,
          ).pipe(Effect.andThen(() => select(transaction))),
        ),
  );

export const makeOperationalScopeRepository = (
  database: { readonly executor: Pick<CoreDatabaseExecutor, 'select' | 'transaction'> },
  enrollment: DatabaseIdentityEnrollment,
): OperationalScopeRepository => ({
  load: (principal) =>
    selectPersistedScope(database, principal, enrollment, (executor) => {
      const impersonators = alias(principals, 'impersonators');
      const bindingAudit = alias(auditEvents, 'binding_creation_audit');
      const scopeAssertion = readVerifiedGatewayScopeAssertion(principal);
      const gatewayScoped =
        scopeAssertion !== undefined &&
        Option.isSome(gatewayScopeGrantRoleForAudience(enrollment, scopeAssertion.audience));
      const query = executor
        .select({
          bindingAuthenticationNamespaceId: principalAuthBindings.authenticationNamespaceId,
          bindingIssuingLegalEntityId: gatewayScoped
            ? sql<
                string | null
              >`trust.auth_binding_issuing_legal_entity(${principal.authBindingId ?? null}::uuid, ${principal.principalId}::uuid)`
            : bindingAudit.legalEntityId,
          bindingPrincipalId: principalAuthBindings.principalId,
          bindingRevision: principalAuthBindings.bindingRevision,
          bindingRevokedAt: principalAuthBindings.revokedAt,
          bindingStatus: principalAuthBindings.status,
          bindingSubjectType: principalAuthBindings.subjectType,
          bindingTenantId: principalAuthBindings.tenantId,
          impersonatorStatus: impersonators.status,
          impersonatorTenantId: impersonators.tenantId,
          legalEntityStatus: legalEntities.status,
          legalEntityTenantId: legalEntities.tenantId,
          principalKind: principals.kind,
          principalStatus: principals.status,
          principalTenantId: principals.tenantId,
          tenantStatus: tenants.status,
        })
        .from(tenants)
        .innerJoin(
          principals,
          and(eq(principals.tenantId, tenants.tenantId), eq(principals.principalId, principal.principalId)),
        )
        .leftJoin(
          impersonators,
          principal.impersonatedByPrincipalId === undefined
            ? eq(impersonators.principalId, '00000000-0000-0000-0000-000000000000')
            : and(
                eq(impersonators.tenantId, principal.tenantId),
                eq(impersonators.principalId, principal.impersonatedByPrincipalId),
              ),
        )
        .leftJoin(
          principalAuthBindings,
          principal.authBindingId === undefined
            ? eq(principalAuthBindings.principalAuthBindingId, '00000000-0000-0000-0000-000000000000')
            : and(
                eq(principalAuthBindings.tenantId, principal.tenantId),
                eq(principalAuthBindings.principalAuthBindingId, principal.authBindingId),
              ),
        );
      // The dedicated request role cannot read binding-creation audit evidence. Its hardened
      // attestation returns only the issuing company within the sealed tenant and company scope.
      const attestedQuery = gatewayScoped
        ? query.$dynamic()
        : query
            .$dynamic()
            .leftJoin(
              bindingAudit,
              and(
                eq(bindingAudit.tenantId, principalAuthBindings.tenantId),
                eq(bindingAudit.actionInvocationId, principalAuthBindings.createdByInvocationId),
                eq(bindingAudit.eventType, 'action.executed'),
                eq(bindingAudit.outcome, 'succeeded'),
                sql`${bindingAudit.evidenceJson}->>'actionKey' = 'core.identity.bind-managed-api-key'`,
              ),
            );
      return attestedQuery
        .leftJoin(
          legalEntities,
          principal.legalEntityId === undefined
            ? eq(legalEntities.legalEntityId, '00000000-0000-0000-0000-000000000000')
            : and(
                eq(legalEntities.tenantId, principal.tenantId),
                eq(legalEntities.legalEntityId, principal.legalEntityId),
              ),
        )
        .where(eq(tenants.tenantId, principal.tenantId))
        .limit(1);
    }).pipe(
      recoverSqlTransactionError,
      Effect.mapError(operationContextUnavailable),
      Effect.map(
        ([record]) =>
          record ?? {
            bindingAuthenticationNamespaceId: null,
            bindingIssuingLegalEntityId: null,
            bindingPrincipalId: null,
            bindingRevision: null,
            bindingRevokedAt: null,
            bindingStatus: null,
            bindingSubjectType: null,
            bindingTenantId: null,
            impersonatorStatus: null,
            impersonatorTenantId: null,
            legalEntityStatus: null,
            legalEntityTenantId: null,
            principalKind: null,
            principalStatus: null,
            principalTenantId: null,
            tenantStatus: null,
          },
      ),
    ),
});

const validateRequestedScope = (
  request: OperationalScopeRequest,
  legalEntityScope: LegalEntityScope,
  principal: TrustedPrincipalContext,
): OperationContextError | undefined => {
  if (request.correlationId.length === 0) {
    return new OperationContextInvalid({
      code: 'operation_context_invalid',
      reason: 'The operation context is incomplete',
    });
  }
  if (legalEntityScope === 'required' && principal.legalEntityId === undefined) {
    return new OperationContextDenied({
      code: 'operation_context_denied',
      reason: 'An active legal entity is required for this operation',
    });
  }
  if (legalEntityScope === 'forbidden' && principal.legalEntityId !== undefined) {
    return new OperationContextInvalid({
      code: 'operation_context_invalid',
      reason: 'This operation does not accept legal-entity context',
    });
  }
  if (principal.authMethod === 'system' && !isTrustedSystemPrincipalContext(principal)) {
    return new OperationAuthenticationRequired({
      code: 'operation_authentication_required',
      reason: 'The system principal context is not trusted',
    });
  }
  if (principal.authMethod !== 'system' && principal.authBindingId === undefined) {
    return new OperationAuthenticationRequired({
      code: 'operation_authentication_required',
      reason: 'The authenticated principal binding is unavailable',
    });
  }
  return undefined;
};

const hasInvalidPersistedBinding = (
  principal: TrustedPrincipalContext,
  persisted: PersistedScopeRecord,
  supportRecovery: boolean,
): boolean => {
  const namespaceMismatch =
    principal.authenticationNamespaceId === undefined
      ? persisted.bindingAuthenticationNamespaceId !== null
      : persisted.bindingAuthenticationNamespaceId !== principal.authenticationNamespaceId;
  return (
    persisted.bindingTenantId !== principal.tenantId ||
    persisted.bindingPrincipalId !== principal.principalId ||
    namespaceMismatch ||
    (!supportRecovery && (persisted.bindingStatus !== 'active' || persisted.bindingRevokedAt !== null))
  );
};

const subjectTypeForPrincipal = (
  principal: TrustedPrincipalContext,
): 'user' | 'api_key' | 'oauth_grant' | undefined => {
  if (principal.authMethod === 'api_key') {
    return 'api_key';
  }
  if (principal.authMethod === 'oauth_connection') {
    return 'oauth_grant';
  }
  if (principal.authMethod === 'session' || principal.authMethod === 'support_impersonation') {
    return 'user';
  }
  return undefined;
};

const validatePersistedPrincipal = (
  principal: TrustedPrincipalContext,
  persisted: PersistedScopeRecord,
  supportRecovery: boolean,
): OperationContextError | undefined => {
  if (
    persisted.principalTenantId !== principal.tenantId ||
    persisted.tenantStatus === null ||
    (!supportRecovery && (persisted.tenantStatus !== 'active' || persisted.principalStatus !== 'active'))
  ) {
    return new OperationContextDenied({
      code: 'operation_context_denied',
      reason: 'The tenant or principal is not active in this operation scope',
    });
  }
  if (principal.authBindingId !== undefined && hasInvalidPersistedBinding(principal, persisted, supportRecovery)) {
    return new OperationAuthenticationRequired({
      code: 'operation_authentication_required',
      reason: 'The authenticated principal binding is no longer valid',
    });
  }
  // The binding's successful creation audit, never the caller's requested scope or the principal's
  // other roles, owns a company-issued agent key's boundary.
  if (
    principal.authMethod === 'api_key' &&
    persisted.principalKind === 'agent' &&
    (persisted.bindingIssuingLegalEntityId === null ||
      persisted.bindingIssuingLegalEntityId === undefined ||
      principal.legalEntityId !== persisted.bindingIssuingLegalEntityId)
  ) {
    return new OperationContextDenied({
      code: 'operation_context_denied',
      reason: 'The agent key requires its issuing company context',
    });
  }
  const expectedSubjectType = subjectTypeForPrincipal(principal);
  if (
    expectedSubjectType !== undefined &&
    persisted.bindingSubjectType !== null &&
    persisted.bindingSubjectType !== undefined &&
    persisted.bindingSubjectType !== expectedSubjectType
  ) {
    return new OperationAuthenticationRequired({
      code: 'operation_authentication_required',
      reason: 'The authenticated principal subject type is not valid',
    });
  }
  return undefined;
};

/**
 * The support administrator's own authority, asked as the impersonation capability's declaration asks
 * it: the capability is the `record-support-impersonation` Action's own declaration (single source of
 * truth), and the question runs in the tenant context as an `admin` capability does (O28, O35).
 */
/** Decoded once, at load: the Action's own carrier is the single source of truth for the capability. */
const SUPPORT_IMPERSONATION_DECLARATION = decodeProtectedAccessDeclaration(
  recordSupportImpersonationAction.descriptor.accessDeclaration,
  recordSupportImpersonationAction.descriptor.entrypoint,
);

/** The administrator as an actor: the effective principal of the request is the impersonated person. */
const impersonatorScopeOf = (
  principal: TrustedPrincipalContext,
  request: OperationalScopeRequest,
  impersonatorPrincipalId: string,
): OperationalScope => {
  const { impersonatedByPrincipalId: _impersonatedByPrincipalId, legalEntityId: _legalEntityId, ...rest } = principal;
  return Object.freeze({
    ...rest,
    authMethod: 'session' as const,
    correlationId: request.correlationId,
    principalId: impersonatorPrincipalId,
  });
};

const validateSupportImpersonation = Effect.fn('OperationalScopeResolver.validateSupportImpersonation')(
  function* validateSupportImpersonationEffect(
    access: OperationalScopeAccess,
    principal: TrustedPrincipalContext,
    persisted: PersistedScopeRecord,
    request: OperationalScopeRequest,
  ) {
    if (principal.authMethod !== 'support_impersonation') {
      return yield* Effect.void;
    }
    const impersonatorPrincipalId = principal.impersonatedByPrincipalId;
    if (
      impersonatorPrincipalId === undefined ||
      persisted.impersonatorStatus !== 'active' ||
      persisted.impersonatorTenantId !== principal.tenantId
    ) {
      return yield* new OperationContextDenied({
        code: 'operation_context_denied',
        reason: 'The support administrator is no longer active in this tenant',
      });
    }

    const now = yield* DateTime.nowAsDate;
    const decision = yield* access.decide({
      carrier: { accessDeclaration: SUPPORT_IMPERSONATION_DECLARATION },
      legalEntityScope: 'optional',
      now,
      scope: impersonatorScopeOf(principal, request, impersonatorPrincipalId),
    });
    if (decision.outcome === 'UNAVAILABLE') {
      return yield* new OperationContextUnavailable({
        code: 'operation_context_unavailable',
        reason: 'Support authorization is temporarily unavailable',
      });
    }
    if (decision.outcome !== 'ALLOWED') {
      // A supported impersonation never waits for an approval: it either holds now or is refused (O35).
      return yield* new OperationContextDenied({
        code: 'operation_context_denied',
        reason: 'Support impersonation permission was revoked',
      });
    }
    return yield* Effect.void;
  },
);

const validateLegalEntity = Effect.fn('OperationalScopeResolver.validateLegalEntity')(
  function* validateLegalEntityEffect(
    access: OperationalScopeAccess,
    principal: TrustedPrincipalContext,
    persisted: PersistedScopeRecord,
    request: OperationalScopeRequest,
  ) {
    const { legalEntityId } = principal;
    if (legalEntityId === undefined) {
      return yield* Effect.void;
    }
    if (persisted.legalEntityStatus !== 'active' || persisted.legalEntityTenantId !== principal.tenantId) {
      return yield* new OperationContextDenied({
        code: 'operation_context_denied',
        reason: 'The selected legal entity is unavailable in this tenant',
      });
    }

    // Registered workload scope was bound by Shell to this original admission; its exact owner capability
    // and current binding incarnation are checked by the owner gate, never a person's company selector.
    if (readVerifiedGatewayWorkload(principal)?.legalEntityId === legalEntityId) {
      return yield* Effect.void;
    }
    const routeScope = readVerifiedGatewayRouteScope(principal);
    if (
      routeScope?.legalEntityId === legalEntityId &&
      routeScope.tenantId === principal.tenantId &&
      routeScope.principalId === principal.principalId
    ) {
      // The exact signed route operations remain mandatory at the receiving gate. A direct
      // integration credential still cannot select a company through the human selector.
      return yield* Effect.void;
    }
    const now = yield* DateTime.nowAsDate;
    // Selectable = access + administer in one scope (O28); the engine answers for the whole company
    // list, so a company this person may not select is refused exactly like a revoked one. The scope
    // keeps the principal's provenance: a gateway-grant identity reads Core only through the scope
    // its redeemed assertion establishes.
    const selectable = yield* Effect.option(
      access.selectableLegalEntities({
        now,
        scope: preserveSystemPrincipalContextTrust(
          principal,
          Object.freeze({ ...principal, correlationId: request.correlationId }),
        ),
      }),
    );
    if (Option.isNone(selectable)) {
      return yield* new OperationContextUnavailable({
        code: 'operation_context_unavailable',
        reason: 'Legal-entity authorization is temporarily unavailable',
      });
    }
    if (!selectable.value.some((candidate) => candidate === legalEntityId)) {
      return yield* new OperationContextDenied({
        code: 'operation_context_denied',
        reason: 'The principal cannot access the selected legal entity',
      });
    }
    return yield* Effect.void;
  },
);

export const makeOperationalScopeResolver = Effect.fnUntraced(function* makeOperationalScopeResolver(
  repository: Pick<OperationalScopeRepository, 'load'>,
  access: OperationalScopeAccess,
): Effect.fn.Return<OperationalScopeResolverService, never, Crypto.Crypto> {
  const crypto = yield* Crypto.Crypto;
  const prepareExternalAdmission = Effect.fn('OperationalScopeResolver.prepareExternalAdmission')(
    function* prepareExternalAdmissionEffect(input: ResolveOperationalScopeInput) {
      const { principal } = input;
      const namespaceId = principal.authenticationNamespaceId;
      if (namespaceId === undefined) {
        return Option.none();
      }
      // Core's principal-context id fields are plain strings on the decoded side
      // (decodedStringBrand); brand at the seam before crossing into the external-identity contract.
      const authenticationNamespaceId = AuthenticationNamespaceIdSchema.make(namespaceId);
      const { authBindingId: plainAuthBindingId, authContextRef } = principal;
      if (plainAuthBindingId === undefined) {
        return yield* new OperationAuthenticationRequired({
          code: 'operation_authentication_required',
          reason: 'The authenticated principal binding is unavailable',
        });
      }
      const authBindingId = AuthBindingIdSchema.make(plainAuthBindingId);
      if (authContextRef === undefined) {
        return yield* new OperationAuthenticationRequired({
          code: 'operation_authentication_required',
          reason: 'The authenticated principal context reference is unavailable',
        });
      }

      const registryOption = yield* Effect.serviceOption(AuthenticationNamespaceRegistry);
      if (Option.isNone(registryOption)) {
        return yield* operationContextUnavailable();
      }
      const registrationOption = yield* registryOption.value
        .lookup(authenticationNamespaceId)
        .pipe(Effect.mapError(operationContextUnavailable));
      if (Option.isNone(registrationOption)) {
        return yield* new OperationAuthenticationRequired({
          code: 'operation_authentication_required',
          reason: 'The authentication namespace is not registered',
        });
      }
      const registration = registrationOption.value;
      if (input.audience !== undefined && !registration.allowedAudiences.includes(input.audience)) {
        return yield* new OperationAuthenticationRequired({
          code: 'operation_authentication_required',
          reason: 'The receiving audience is not registered for this namespace',
        });
      }
      const subjectType = subjectTypeForPrincipal(principal);
      if (subjectType === undefined || !registration.subjectTypes.includes(subjectType)) {
        return yield* new OperationAuthenticationRequired({
          code: 'operation_authentication_required',
          reason: 'The authentication subject type is not registered for this namespace',
        });
      }
      if (!registration.requiresOperationAdmission) {
        return Option.none();
      }
      if (input.audience === undefined || input.audience.length === 0) {
        return yield* new OperationAuthenticationRequired({
          code: 'operation_authentication_required',
          reason: 'The receiving audience is required for external admission',
        });
      }
      const authenticationOption = yield* Effect.serviceOption(ExternalOperationAuthentication);
      if (Option.isNone(authenticationOption)) {
        return yield* operationContextUnavailable();
      }
      const operationRef = yield* crypto.randomUUIDv4().pipe(Effect.mapError(operationContextUnavailable));
      const nonce = yield* crypto.randomUUIDv4().pipe(Effect.mapError(operationContextUnavailable));
      const request: ExternalOperationAuthenticationRequest = {
        audience: input.audience,
        authBindingId,
        authContextRef,
        authenticationNamespaceId,
        nonce,
        operationRef,
        principal,
        principalId: PrincipalIdSchema.make(principal.principalId),
        subjectType,
        tenantId: TenantIdSchema.make(principal.tenantId),
      };
      const admission = yield* authenticationOption.value.verify(request);
      return Option.some({
        admission,
        audience: input.audience,
        authBindingId,
        authContextRef,
        authenticationNamespaceId,
        nonce,
        operationRef,
      });
    },
  );

  const resolveOperationalScope = Effect.fn('OperationalScopeResolver.resolve')(function* resolveOperationalScopeEffect(
    input: ResolveOperationalScopeInput,
  ) {
    const workload = readVerifiedGatewayWorkload(input.principal);
    const principal =
      workload?.legalEntityId === undefined
        ? input.principal
        : preserveSystemPrincipalContextTrust(input.principal, {
            ...input.principal,
            legalEntityId: workload.legalEntityId,
          });
    const requestFailure = validateRequestedScope(input, input.legalEntityScope, principal);
    if (requestFailure !== undefined) {
      return yield* requestFailure;
    }

    const externalAdmission = yield* prepareExternalAdmission(input);

    // P must complete before C so provider HTTP never shares the Core load's transaction.
    // oxlint-disable-next-line effect-native/no-sequential-independent-yields -- Admission ordering is the security contract.
    const persisted = yield* repository.load(principal);
    const supportRecovery = isTrustedSupportRecoveryPrincipalContext(principal);
    const persistedFailure = validatePersistedPrincipal(principal, persisted, supportRecovery);
    if (persistedFailure !== undefined) {
      return yield* persistedFailure;
    }

    if (Option.isSome(externalAdmission)) {
      if (persisted.bindingRevision === null || persisted.bindingRevision === undefined) {
        return yield* operationContextUnavailable();
      }
      yield* assertAuthenticationAdmission(externalAdmission.value.admission, {
        audience: externalAdmission.value.audience,
        authBindingId: externalAdmission.value.authBindingId,
        authContextRef: externalAdmission.value.authContextRef,
        authenticationNamespaceId: externalAdmission.value.authenticationNamespaceId,
        bindingRevision: persisted.bindingRevision,
        nonce: externalAdmission.value.nonce,
        operationRef: externalAdmission.value.operationRef,
        principalId: PrincipalIdSchema.make(principal.principalId),
        tenantId: TenantIdSchema.make(principal.tenantId),
      }).pipe(
        Effect.mapError((cause) => {
          const failure = new OperationAuthenticationRequired({
            code: 'operation_authentication_required',
            reason: 'The authentication admission does not match current Core identity',
          });
          return Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
        }),
      );
    }

    yield* validateSupportImpersonation(access, principal, persisted, input);
    yield* validateLegalEntity(access, principal, persisted, input);
    return preserveSystemPrincipalContextTrust(
      principal,
      Object.freeze(
        withOptionalProperty(
          {
            ...principal,
            correlationId: input.correlationId,
          },
          input.traceId !== undefined,
          'traceId',
          input.traceId,
          {},
        ),
      ),
    );
  });

  return { resolve: resolveOperationalScope };
});

export const OperationalScopeRepositoryLive = Layer.effect(
  OperationalScopeRepositoryContext,
  Effect.gen(function* createOperationalScopeRepositoryService() {
    const database = yield* CoreDatabase;
    const enrollment = yield* DatabaseIdentityEnrollmentContext;
    return makeOperationalScopeRepository(database, enrollment);
  }),
);

export const OperationalScopeResolverFromRepositoryLive = Layer.effect(
  OperationalScopeResolver,
  Effect.gen(function* createOperationalScopeResolverService() {
    const repository = yield* OperationalScopeRepositoryContext;
    const access = yield* bindLiveAccessGate;
    return yield* makeOperationalScopeResolver(repository, access);
  }),
);

export const OperationalScopeResolverLive = Layer.effect(
  OperationalScopeResolver,
  Effect.gen(function* createLiveOperationalScopeResolverService() {
    const database = yield* CoreDatabase;
    const enrollment = yield* DatabaseIdentityEnrollmentContext;
    const access = yield* bindLiveAccessGate;
    return yield* makeOperationalScopeResolver(makeOperationalScopeRepository(database, enrollment), access);
  }),
);
