// @effect-diagnostics asyncFunction:off
/* eslint-disable max-classes-per-file -- The recovery resolver and its closed failures form one capability boundary. */
import { and, eq } from 'drizzle-orm';
import { Context, Effect, Layer, Schema } from 'effect';
import type { TrustedPrincipalContext } from '../actions/principal-context.ts';
import { CoreDatabase } from '../db/client.ts';
import { principalAuthBindings, principals, tenants } from '../db/schema.ts';
import type { CoreDatabaseExecutor } from '../db/types.ts';
import { trustSupportRecoveryPrincipalContext } from './system-principal-context-provenance.ts';
import { recordSupportImpersonationAction } from '../modules/actions/record-support-impersonation.action.ts';

const uuid = Schema.String.check(Schema.isUUID());

export class SupportRecoveryPrincipalContextDeniedError extends Schema.TaggedErrorClass<SupportRecoveryPrincipalContextDeniedError>()(
  'SupportRecoveryPrincipalContextDeniedError',
  { code: Schema.Literal('support_recovery_context_denied'), reason: Schema.String },
) {}
export class SupportRecoveryPrincipalContextUnavailableError extends Schema.TaggedErrorClass<SupportRecoveryPrincipalContextUnavailableError>()(
  'SupportRecoveryPrincipalContextUnavailableError',
  { code: Schema.Literal('support_recovery_context_unavailable'), reason: Schema.String },
) {}
export type SupportRecoveryPrincipalContextError =
  | SupportRecoveryPrincipalContextDeniedError
  | SupportRecoveryPrincipalContextUnavailableError;

export interface SupportRecoveryPrincipalContextResolverShape {
  readonly resolveStoppedImpersonation: (input: {
    readonly originalAuthBindingId: string;
    readonly originalPrincipalId: string;
    readonly originalSessionId: string;
    readonly tenantId: string;
  }) => Effect.Effect<TrustedPrincipalContext, SupportRecoveryPrincipalContextError>;
}

export const makeSupportRecoveryPrincipalContextResolver = (database: {
  readonly executor: Pick<CoreDatabaseExecutor, 'select'>;
}): SupportRecoveryPrincipalContextResolverShape => ({
  resolveStoppedImpersonation: (input) =>
    Effect.gen(function* resolveSupportRecoveryPrincipal() {
      if (
        !Schema.is(uuid)(input.originalAuthBindingId) ||
        !Schema.is(uuid)(input.originalPrincipalId) ||
        !Schema.is(uuid)(input.tenantId) ||
        input.originalSessionId.length === 0 ||
        input.originalSessionId.length > 280 ||
        /\s/u.test(input.originalSessionId)
      ) {
        return yield* new SupportRecoveryPrincipalContextDeniedError({
          code: 'support_recovery_context_denied',
          reason: 'The support recovery identity is invalid',
        });
      }
      const record = yield* Effect.tryPromise({
        catch: () =>
          new SupportRecoveryPrincipalContextUnavailableError({
            code: 'support_recovery_context_unavailable',
            reason: 'The support recovery identity could not be revalidated',
          }),
        try: async () => {
          const [loaded] = await database.executor
            .select({
              bindingPrincipalId: principalAuthBindings.principalId,
              bindingTenantId: principalAuthBindings.tenantId,
              principalKind: principals.kind,
              principalTenantId: principals.tenantId,
              tenantId: tenants.tenantId,
            })
            .from(principalAuthBindings)
            .innerJoin(
              principals,
              and(
                eq(principals.tenantId, principalAuthBindings.tenantId),
                eq(principals.principalId, principalAuthBindings.principalId),
              ),
            )
            .innerJoin(tenants, eq(tenants.tenantId, principalAuthBindings.tenantId))
            .where(
              and(
                eq(principalAuthBindings.principalAuthBindingId, input.originalAuthBindingId),
                eq(principalAuthBindings.tenantId, input.tenantId),
                eq(principalAuthBindings.principalId, input.originalPrincipalId),
                eq(principalAuthBindings.provider, 'better_auth'),
                eq(principalAuthBindings.subjectType, 'user'),
              ),
            )
            .limit(1);
          return loaded;
        },
      });
      if (
        record?.bindingPrincipalId !== input.originalPrincipalId ||
        record.bindingTenantId !== input.tenantId ||
        record.principalKind !== 'human' ||
        record.principalTenantId !== input.tenantId ||
        record.tenantId !== input.tenantId
      ) {
        return yield* new SupportRecoveryPrincipalContextDeniedError({
          code: 'support_recovery_context_denied',
          reason: 'The support recovery identity is not a historical tenant-local user binding',
        });
      }
      return trustSupportRecoveryPrincipalContext(
        Object.freeze({
          authBindingId: input.originalAuthBindingId,
          authContextRef: `better-auth-session:${input.originalSessionId}`,
          authMethod: 'session' as const,
          principalId: input.originalPrincipalId,
          tenantId: input.tenantId,
        }),
        recordSupportImpersonationAction,
      );
    }),
});

export class SupportRecoveryPrincipalContextResolver extends Context.Service<
  SupportRecoveryPrincipalContextResolver,
  SupportRecoveryPrincipalContextResolverShape
>()(
  '@app/core-runtime/auth/support-recovery-principal-context/SupportRecoveryPrincipalContextResolver',
) {}

export const SupportRecoveryPrincipalContextResolverLive = Layer.effect(
  SupportRecoveryPrincipalContextResolver,
  CoreDatabase.pipe(Effect.map(makeSupportRecoveryPrincipalContextResolver)),
);
