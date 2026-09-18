import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { Context, Effect, Layer, Option } from 'effect';

import type { TrustedPrincipalContext } from '../actions/principal-context.ts';
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
} from '../auth/system-principal-context-provenance.ts';
import { CoreDatabase } from '../db/client.ts';
import { legalEntities, principalAuthBindings, principals, tenants } from '../db/schema.ts';
import type { CoreDatabaseExecutor } from '../db/types.ts';
import type { ContextAccessService } from '../permissions/context-access.ts';
import { ContextAccess } from '../permissions/context-access.ts';
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

export type { OperationalScopeRepository } from './repository-context.ts';

const withOptionalProperty = <Base extends object, Key extends PropertyKey, Value, Trailing extends object>(
  base: Base,
  condition: boolean,
  key: Key,
  value: Value,
  trailing: Trailing,
) => (condition ? { ...base, [key]: value, ...trailing } : { ...base, ...trailing });

export const LEGAL_ENTITY_SCOPES = ['required', 'optional', 'forbidden'] as const;
export type LegalEntityScope = (typeof LEGAL_ENTITY_SCOPES)[number];

export interface OperationalScopeRequest {
  /** Receiver audience used to bind an external admission to this call. */
  readonly audience?: string;
  readonly correlationId: string;
  readonly traceId?: string;
}

export interface OperationalScope extends Readonly<TrustedPrincipalContext>, Readonly<OperationalScopeRequest> {}

export type LegalEntityScopeAccess = Pick<ContextAccessService, 'legalEntities'> &
  Partial<Pick<ContextAccessService, 'tenants'>>;

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

export const makeOperationalScopeRepository = (database: {
  readonly executor: Pick<CoreDatabaseExecutor, 'select'>;
}): OperationalScopeRepository => ({
  load: (principal) =>
    Effect.suspend(() => {
      const impersonators = alias(principals, 'impersonators');
      return database.executor
        .select({
          bindingAuthenticationNamespaceId: principalAuthBindings.authenticationNamespaceId,
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
        )
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
      Effect.mapError(operationContextUnavailable),
      Effect.map(
        ([record]) =>
          record ?? {
            bindingAuthenticationNamespaceId: null,
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

const subjectTypeForPrincipal = (principal: TrustedPrincipalContext): 'user' | 'api_key' | undefined => {
  if (principal.authMethod === 'api_key') {
    return 'api_key';
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

const validateSupportImpersonation = Effect.fn('OperationalScopeResolver.validateSupportImpersonation')(
  function* validateSupportImpersonationEffect(
    contextAccess: LegalEntityScopeAccess,
    principal: TrustedPrincipalContext,
    persisted: PersistedScopeRecord,
  ) {
    if (principal.authMethod !== 'support_impersonation') {
      return yield* Effect.void;
    }
    if (
      principal.impersonatedByPrincipalId === undefined ||
      persisted.impersonatorStatus !== 'active' ||
      persisted.impersonatorTenantId !== principal.tenantId
    ) {
      return yield* new OperationContextDenied({
        code: 'operation_context_denied',
        reason: 'The support administrator is no longer active in this tenant',
      });
    }

    if (contextAccess.tenants === undefined) {
      return yield* new OperationContextUnavailable({
        code: 'operation_context_unavailable',
        reason: 'Support authorization is temporarily unavailable',
      });
    }
    const [supportDecision] = yield* contextAccess.tenants({
      permission: 'impersonate',
      principalId: principal.impersonatedByPrincipalId,
      tenantIds: [principal.tenantId],
    });
    if (supportDecision?.decision === 'denied') {
      return yield* new OperationContextDenied({
        code: 'operation_context_denied',
        reason: 'Support impersonation permission was revoked',
      });
    }
    if (supportDecision?.decision !== 'allowed') {
      return yield* new OperationContextUnavailable({
        code: 'operation_context_unavailable',
        reason: 'Support authorization is temporarily unavailable',
      });
    }
    return yield* Effect.void;
  },
);

const validateLegalEntity = Effect.fn('OperationalScopeResolver.validateLegalEntity')(
  function* validateLegalEntityEffect(
    contextAccess: LegalEntityScopeAccess,
    principal: TrustedPrincipalContext,
    persisted: PersistedScopeRecord,
  ) {
    if (principal.legalEntityId === undefined) {
      return yield* Effect.void;
    }
    if (persisted.legalEntityStatus !== 'active' || persisted.legalEntityTenantId !== principal.tenantId) {
      return yield* new OperationContextDenied({
        code: 'operation_context_denied',
        reason: 'The selected legal entity is unavailable in this tenant',
      });
    }

    const [decision] = yield* contextAccess.legalEntities({
      legalEntityIds: [principal.legalEntityId],
      principalId: principal.principalId,
      tenantId: principal.tenantId,
    });
    if (decision?.decision === 'denied') {
      return yield* new OperationContextDenied({
        code: 'operation_context_denied',
        reason: 'The principal cannot access the selected legal entity',
      });
    }
    if (decision?.decision !== 'allowed') {
      return yield* new OperationContextUnavailable({
        code: 'operation_context_unavailable',
        reason: 'Legal-entity authorization is temporarily unavailable',
      });
    }
    return yield* Effect.void;
  },
);

export const makeOperationalScopeResolver = (
  repository: Pick<OperationalScopeRepository, 'load'>,
  contextAccess: LegalEntityScopeAccess,
): OperationalScopeResolverService => {
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
      const operationRef = yield* Effect.sync(randomUUID).pipe(Effect.mapError(operationContextUnavailable));
      const nonce = yield* Effect.sync(randomUUID).pipe(Effect.mapError(operationContextUnavailable));
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
    const { principal } = input;
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

    yield* validateSupportImpersonation(contextAccess, principal, persisted);
    yield* validateLegalEntity(contextAccess, principal, persisted);
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
};

export const OperationalScopeRepositoryLive = Layer.effect(
  OperationalScopeRepositoryContext,
  CoreDatabase.pipe(Effect.map(makeOperationalScopeRepository)),
);

export const OperationalScopeResolverFromRepositoryLive = Layer.effect(
  OperationalScopeResolver,
  Effect.gen(function* createOperationalScopeResolverService() {
    const repository = yield* OperationalScopeRepositoryContext;
    const contextAccess = yield* ContextAccess;
    return makeOperationalScopeResolver(repository, contextAccess);
  }),
);

export const OperationalScopeResolverLive = Layer.effect(
  OperationalScopeResolver,
  Effect.gen(function* createLiveOperationalScopeResolverService() {
    const database = yield* CoreDatabase;
    const contextAccess = yield* ContextAccess;
    return makeOperationalScopeResolver(makeOperationalScopeRepository(database), contextAccess);
  }),
);
