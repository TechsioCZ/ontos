// @effect-diagnostics asyncFunction:off
/* eslint-disable complexity -- The resolver intentionally keeps the fail-closed gate order visible. */
import { and, eq } from 'drizzle-orm';
import { Context, Effect } from 'effect';
import { alias } from 'drizzle-orm/pg-core';
import type { TrustedPrincipalContext } from '../actions/principal-context.ts';
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

export const LEGAL_ENTITY_SCOPES = ['required', 'optional', 'forbidden'] as const;
export type LegalEntityScope = (typeof LEGAL_ENTITY_SCOPES)[number];

export interface OperationalScope extends Readonly<TrustedPrincipalContext> {
  readonly correlationId: string;
  readonly traceId?: string;
}

interface PersistedScopeRecord {
  readonly bindingPrincipalId: null | string;
  readonly bindingRevokedAt: Date | null;
  readonly bindingStatus: null | string;
  readonly bindingTenantId: null | string;
  readonly legalEntityStatus: null | string;
  readonly legalEntityTenantId: null | string;
  readonly principalStatus: null | string;
  readonly principalTenantId: null | string;
  readonly impersonatorStatus?: null | string;
  readonly impersonatorTenantId?: null | string;
  readonly tenantStatus: null | string;
}

export interface OperationalScopeRepository {
  readonly load: (
    principal: TrustedPrincipalContext,
  ) => Effect.Effect<PersistedScopeRecord, OperationContextUnavailable>;
}

export interface LegalEntityScopeAccess {
  readonly tenants?: (input: {
    readonly permission: 'access' | 'impersonate' | 'manage_identity';
    readonly principalId: string;
    readonly tenantIds: readonly string[];
  }) => Effect.Effect<
    readonly { readonly decision: 'allowed' | 'denied' | 'unavailable'; readonly key: string }[]
  >;
  readonly legalEntities: (input: {
    readonly legalEntityIds: readonly string[];
    readonly principalId: string;
    readonly tenantId: string;
  }) => Effect.Effect<
    readonly { readonly decision: 'allowed' | 'denied' | 'unavailable'; readonly key: string }[]
  >;
}

export interface ResolveOperationalScopeInput {
  readonly correlationId: string;
  readonly legalEntityScope: LegalEntityScope;
  readonly principal: TrustedPrincipalContext;
  readonly traceId?: string;
}

export interface OperationalScopeResolverShape {
  readonly resolve: (
    input: ResolveOperationalScopeInput,
  ) => Effect.Effect<OperationalScope, OperationContextError>;
}

export class OperationalScopeResolver extends Context.Service<
  OperationalScopeResolver,
  OperationalScopeResolverShape
>()('@app/core-runtime/operations/context/OperationalScopeResolver') {}

export const makeOperationalScopeRepository = (database: {
  readonly executor: Pick<CoreDatabaseExecutor, 'select'>;
}): OperationalScopeRepository => ({
  load: (principal) =>
    Effect.tryPromise({
      catch: () =>
        new OperationContextUnavailable({
          code: 'operation_context_unavailable',
          reason: 'The operation context could not be revalidated',
        }),
      try: async () => {
        const impersonators = alias(principals, 'impersonators');
        const [record] = await database.executor
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
        return (
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
          }
        );
      },
    }),
});

export const makeOperationalScopeResolver = (
  repository: OperationalScopeRepository,
  contextAccess: LegalEntityScopeAccess,
): OperationalScopeResolverShape => ({
  resolve: (input) =>
    Effect.gen(function* resolveOperationalScope() {
      const { principal } = input;
      const supportRecovery = isTrustedSupportRecoveryPrincipalContext(principal);
      if (input.correlationId.length === 0) {
        return yield* new OperationContextInvalid({
          code: 'operation_context_invalid',
          reason: 'The operation context is incomplete',
        });
      }
      if (input.legalEntityScope === 'required' && principal.legalEntityId === undefined) {
        return yield* new OperationContextDenied({
          code: 'operation_context_denied',
          reason: 'An active legal entity is required for this operation',
        });
      }
      if (input.legalEntityScope === 'forbidden' && principal.legalEntityId !== undefined) {
        return yield* new OperationContextInvalid({
          code: 'operation_context_invalid',
          reason: 'This operation does not accept legal-entity context',
        });
      }
      if (principal.authMethod === 'system' && !isTrustedSystemPrincipalContext(principal)) {
        return yield* new OperationAuthenticationRequired({
          code: 'operation_authentication_required',
          reason: 'The system principal context is not trusted',
        });
      }
      if (principal.authMethod !== 'system' && principal.authBindingId === undefined) {
        return yield* new OperationAuthenticationRequired({
          code: 'operation_authentication_required',
          reason: 'The authenticated principal binding is unavailable',
        });
      }

      const persisted = yield* repository.load(principal);
      if (
        persisted.principalTenantId !== principal.tenantId ||
        persisted.tenantStatus === null ||
        (!supportRecovery &&
          (persisted.tenantStatus !== 'active' || persisted.principalStatus !== 'active'))
      ) {
        return yield* new OperationContextDenied({
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
        return yield* new OperationAuthenticationRequired({
          code: 'operation_authentication_required',
          reason: 'The authenticated principal binding is no longer valid',
        });
      }
      if (principal.authMethod === 'support_impersonation') {
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
      }
      if (
        principal.legalEntityId !== undefined &&
        (persisted.legalEntityStatus !== 'active' ||
          persisted.legalEntityTenantId !== principal.tenantId)
      ) {
        return yield* new OperationContextDenied({
          code: 'operation_context_denied',
          reason: 'The selected legal entity is unavailable in this tenant',
        });
      }
      if (principal.legalEntityId !== undefined) {
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
      }
      return preserveSystemPrincipalContextTrust(
        principal,
        Object.freeze({
          ...principal,
          correlationId: input.correlationId,
          ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
        }),
      );
    }),
});
