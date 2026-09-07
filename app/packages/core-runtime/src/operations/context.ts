import { and, eq } from 'drizzle-orm';
import { Context, Duration, Effect, Layer } from 'effect';
import { alias } from 'drizzle-orm/pg-core';
import type { TrustedPrincipalContext } from '../actions/principal-context.ts';
import { CoreDatabase } from '../db/client.ts';
import { ContextAccess } from '../permissions/context-access.ts';
import type { ContextAccessService } from '../permissions/context-access.ts';
import {
  isTrustedSupportRecoveryPrincipalContext,
  isTrustedSystemPrincipalContext,
  preserveSystemPrincipalContextTrust,
} from '../auth/system-principal-context-provenance.ts';
import { legalEntities, principalAuthBindings, principals, tenants } from '../db/schema.ts';
import type { CoreDatabaseExecutor } from '../db/types.ts';
import {
  OperationAuthenticationRequired,
  OperationContextDenied,
  OperationContextInvalid,
  OperationContextUnavailable,
} from './errors.ts';
import type { OperationContextError } from './errors.ts';
import { OperationalScopeRepositoryContext } from './repository-context.ts';
import type { OperationalScopeRepository, PersistedScopeRecord } from './repository-context.ts';

export type { OperationalScopeRepository } from './repository-context.ts';

const withOptionalProperty = <
  Base extends object,
  Key extends PropertyKey,
  Value,
  Trailing extends object,
>(
  base: Base,
  condition: boolean,
  key: Key,
  value: Value,
  trailing: Trailing,
) => (condition ? { ...base, [key]: value, ...trailing } : { ...base, ...trailing });

export const LEGAL_ENTITY_SCOPES = ['required', 'optional', 'forbidden'] as const;
export type LegalEntityScope = (typeof LEGAL_ENTITY_SCOPES)[number];

export interface OperationalScopeRequest {
  readonly correlationId: string;
  readonly traceId?: string;
}

export interface OperationalScope
  extends Readonly<TrustedPrincipalContext>, Readonly<OperationalScopeRequest> {}

export type LegalEntityScopeAccess = Pick<ContextAccessService, 'legalEntities'> &
  Partial<Pick<ContextAccessService, 'tenants'>>;

export interface ResolveOperationalScopeInput extends Readonly<OperationalScopeRequest> {
  readonly legalEntityScope: LegalEntityScope;
  readonly principal: TrustedPrincipalContext;
}

export interface OperationalScopeResolverService {
  readonly resolve: (
    input: ResolveOperationalScopeInput,
  ) => Effect.Effect<OperationalScope, OperationContextError>;
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
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

// The Drizzle query exposes no AbortSignal. Keep the original unbounded driver lifetime instead of
// introducing a deadline that abandons an in-flight query while reporting it as cancelled.
const OPERATION_SCOPE_LOAD_TIMEOUT = Duration.infinity;

export const makeOperationalScopeRepository = (database: {
  readonly executor: Pick<CoreDatabaseExecutor, 'select'>;
}): OperationalScopeRepository => ({
  load: (principal) =>
    Effect.tryPromise({
      catch: operationContextUnavailable,
      try: () => {
        const impersonators = alias(principals, 'impersonators');
        return database.executor
          .select({
            bindingPrincipalId: principalAuthBindings.principalId,
            bindingRevokedAt: principalAuthBindings.revokedAt,
            bindingStatus: principalAuthBindings.status,
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
            and(
              eq(principals.tenantId, tenants.tenantId),
              eq(principals.principalId, principal.principalId),
            ),
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
              ? eq(
                  principalAuthBindings.principalAuthBindingId,
                  '00000000-0000-0000-0000-000000000000',
                )
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
      },
    }).pipe(
      Effect.map(
        ([record]) =>
          record ?? {
            bindingPrincipalId: null,
            bindingRevokedAt: null,
            bindingStatus: null,
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
      Effect.timeoutOrElse({
        duration: OPERATION_SCOPE_LOAD_TIMEOUT,
        orElse: () => Effect.fail(operationContextUnavailable()),
      }),
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

const validatePersistedPrincipal = (
  principal: TrustedPrincipalContext,
  persisted: PersistedScopeRecord,
  supportRecovery: boolean,
): OperationContextError | undefined => {
  if (
    persisted.principalTenantId !== principal.tenantId ||
    persisted.tenantStatus === null ||
    (!supportRecovery &&
      (persisted.tenantStatus !== 'active' || persisted.principalStatus !== 'active'))
  ) {
    return new OperationContextDenied({
      code: 'operation_context_denied',
      reason: 'The tenant or principal is not active in this operation scope',
    });
  }
  if (
    principal.authBindingId !== undefined &&
    (persisted.bindingTenantId !== principal.tenantId ||
      persisted.bindingPrincipalId !== principal.principalId ||
      (!supportRecovery &&
        (persisted.bindingStatus !== 'active' || persisted.bindingRevokedAt !== null)))
  ) {
    return new OperationAuthenticationRequired({
      code: 'operation_authentication_required',
      reason: 'The authenticated principal binding is no longer valid',
    });
  }
  return undefined;
};

const validateSupportImpersonation = Effect.fn(
  'OperationalScopeResolver.validateSupportImpersonation',
)(function* validateSupportImpersonationEffect(
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
});

const validateLegalEntity = Effect.fn('OperationalScopeResolver.validateLegalEntity')(
  function* validateLegalEntityEffect(
    contextAccess: LegalEntityScopeAccess,
    principal: TrustedPrincipalContext,
    persisted: PersistedScopeRecord,
  ) {
    if (principal.legalEntityId === undefined) {
      return yield* Effect.void;
    }
    if (
      persisted.legalEntityStatus !== 'active' ||
      persisted.legalEntityTenantId !== principal.tenantId
    ) {
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
  const resolveOperationalScope = Effect.fn('OperationalScopeResolver.resolve')(
    function* resolveOperationalScopeEffect(input: ResolveOperationalScopeInput) {
      const { principal } = input;
      const requestFailure = validateRequestedScope(input, input.legalEntityScope, principal);
      if (requestFailure !== undefined) {
        return yield* requestFailure;
      }

      const persisted = yield* repository.load(principal);
      const supportRecovery = isTrustedSupportRecoveryPrincipalContext(principal);
      const persistedFailure = validatePersistedPrincipal(principal, persisted, supportRecovery);
      if (persistedFailure !== undefined) {
        return yield* persistedFailure;
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
    },
  );

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
