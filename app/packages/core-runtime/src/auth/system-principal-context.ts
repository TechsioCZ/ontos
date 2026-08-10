// @effect-diagnostics asyncFunction:off
/* eslint-disable max-classes-per-file -- Trusted registration and its typed failures form one boundary. */
import { and, eq } from 'drizzle-orm';
import { Effect, Schema } from 'effect';
import type { TrustedPrincipalContext } from '../actions/principal-context.ts';
import { trustResolvedSystemPrincipalContext } from './system-principal-context-provenance.ts';
import { principals, tenants } from '../db/schema.ts';
import type { CoreDatabaseExecutor } from '../db/types.ts';

export class SystemPrincipalContextInvalidError extends Schema.TaggedErrorClass<SystemPrincipalContextInvalidError>()(
  'SystemPrincipalContextInvalidError',
  { code: Schema.Literal('system_principal_context_invalid'), reason: Schema.String },
) {}
export class SystemPrincipalContextDeniedError extends Schema.TaggedErrorClass<SystemPrincipalContextDeniedError>()(
  'SystemPrincipalContextDeniedError',
  { code: Schema.Literal('system_principal_context_denied'), reason: Schema.String },
) {}
export class SystemPrincipalContextUnavailableError extends Schema.TaggedErrorClass<SystemPrincipalContextUnavailableError>()(
  'SystemPrincipalContextUnavailableError',
  { code: Schema.Literal('system_principal_context_unavailable'), reason: Schema.String },
) {}
export type SystemPrincipalContextError =
  | SystemPrincipalContextDeniedError
  | SystemPrincipalContextInvalidError
  | SystemPrincipalContextUnavailableError;

export interface SystemWorkloadRegistration {
  readonly allowServicePrincipal: boolean;
  readonly jobKey: string;
}
const registrations = new WeakSet<object>();
const safePart = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/u;

export const registerSystemWorkload = (input: {
  readonly allowServicePrincipal?: boolean;
  readonly jobKey: string;
}): SystemWorkloadRegistration => {
  if (!safePart.test(input.jobKey)) {
    throw new TypeError('System workload job key is invalid');
  }
  const registration = Object.freeze({
    allowServicePrincipal: input.allowServicePrincipal === true,
    jobKey: input.jobKey,
  });
  registrations.add(registration);
  return registration;
};

export const makeSystemPrincipalContextResolver = (database: {
  readonly executor: Pick<CoreDatabaseExecutor, 'select'>;
}) => ({
  resolve: (input: {
    readonly principalId: string;
    readonly registration: SystemWorkloadRegistration;
    readonly runReference: string;
    readonly tenantId: string;
  }): Effect.Effect<TrustedPrincipalContext, SystemPrincipalContextError> =>
    Effect.gen(function* resolveSystemContext() {
      if (
        !registrations.has(input.registration) ||
        !safePart.test(input.runReference) ||
        !Schema.is(Schema.String.check(Schema.isUUID()))(input.tenantId) ||
        !Schema.is(Schema.String.check(Schema.isUUID()))(input.principalId)
      ) {
        return yield* new SystemPrincipalContextInvalidError({
          code: 'system_principal_context_invalid',
          reason: 'The trusted system workload registration is invalid',
        });
      }
      const record = yield* Effect.tryPromise({
        catch: () =>
          new SystemPrincipalContextUnavailableError({
            code: 'system_principal_context_unavailable',
            reason: 'The system principal could not be revalidated',
          }),
        try: async () => {
          const [loaded] = await database.executor
            .select({
              kind: principals.kind,
              principalStatus: principals.status,
              tenantStatus: tenants.status,
            })
            .from(principals)
            .innerJoin(tenants, eq(tenants.tenantId, principals.tenantId))
            .where(
              and(
                eq(principals.tenantId, input.tenantId),
                eq(principals.principalId, input.principalId),
              ),
            )
            .limit(1);
          return loaded;
        },
      });
      const kindAllowed =
        record?.kind === 'system' ||
        (input.registration.allowServicePrincipal && record?.kind === 'service');
      if (
        record?.principalStatus !== 'active' ||
        record?.tenantStatus !== 'active' ||
        !kindAllowed
      ) {
        return yield* new SystemPrincipalContextDeniedError({
          code: 'system_principal_context_denied',
          reason: 'The configured system principal is not active and eligible in this tenant',
        });
      }
      return trustResolvedSystemPrincipalContext(
        Object.freeze({
          authContextRef: `job:${input.registration.jobKey}:run:${input.runReference}`,
          authMethod: 'system' as const,
          principalId: input.principalId,
          tenantId: input.tenantId,
        }),
      );
    }),
});
