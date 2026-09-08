import { and, eq } from 'drizzle-orm';
import { Duration, Effect, Option, Schema } from 'effect';

import type { TrustedPrincipalContext } from '../actions/principal-context.ts';
import { principals, tenants } from '../db/schema.ts';
import type { CoreDatabaseExecutor } from '../db/types.ts';
import { SystemPrincipalContextDeniedError } from './system-principal-context-denied-error.ts';
import { SystemPrincipalContextInvalidError } from './system-principal-context-invalid-error.ts';
import { trustResolvedSystemPrincipalContext } from './system-principal-context-provenance.ts';
import { SystemPrincipalContextUnavailableError } from './system-principal-context-unavailable-error.ts';
import { SystemWorkloadRegistrationInvalidError } from './system-workload-registration-invalid-error.ts';

export { SystemPrincipalContextDeniedError } from './system-principal-context-denied-error.ts';
export { SystemPrincipalContextInvalidError } from './system-principal-context-invalid-error.ts';
export { SystemPrincipalContextUnavailableError } from './system-principal-context-unavailable-error.ts';

export type SystemPrincipalContextError =
  | SystemPrincipalContextDeniedError
  | SystemPrincipalContextInvalidError
  | SystemPrincipalContextUnavailableError;

const registrationProvenance = Symbol('SystemWorkloadRegistration');

export interface SystemWorkloadRegistration {
  readonly allowServicePrincipal: boolean;
  readonly jobKey: string;
  readonly [registrationProvenance]?: true;
}
const safePart = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/u;

const rejectInvalidSystemWorkloadRegistration = (): never => {
  const failure = new SystemWorkloadRegistrationInvalidError({
    code: 'system_workload_registration_invalid',
    message: 'System workload job key is invalid',
  });
  Object.setPrototypeOf(failure, TypeError.prototype);
  throw failure;
};

export const registerSystemWorkload = (input: {
  readonly allowServicePrincipal?: boolean;
  readonly jobKey: string;
}): SystemWorkloadRegistration => {
  if (!safePart.test(input.jobKey)) {
    return rejectInvalidSystemWorkloadRegistration();
  }
  const registration: SystemWorkloadRegistration = {
    allowServicePrincipal: input.allowServicePrincipal === true,
    jobKey: input.jobKey,
  };
  Object.defineProperty(registration, registrationProvenance, { value: true });
  return Object.freeze(registration);
};

interface SystemPrincipalContextRecord {
  readonly kind: (typeof principals.$inferSelect)['kind'];
  readonly principalStatus: (typeof principals.$inferSelect)['status'];
  readonly tenantStatus: (typeof tenants.$inferSelect)['status'];
}

type SystemPrincipalContextRepositoryLoadResult = Effect.Effect<
  Option.Option<SystemPrincipalContextRecord>,
  SystemPrincipalContextUnavailableError
>;

interface SystemPrincipalContextRecordReader<
  Result extends SystemPrincipalContextRepositoryLoadResult,
> {
  readonly load: (input: {
    readonly principalId: string;
    readonly tenantId: string;
  }) => Result;
}

const attachCause = <Failure extends object>(
  failure: Failure,
  cause: unknown
): Failure =>
  cause === undefined
    ? failure
    : Object.defineProperty(failure, 'cause', { value: cause });

const unavailable = (cause?: unknown): SystemPrincipalContextUnavailableError =>
  attachCause(
    new SystemPrincipalContextUnavailableError({
      code: 'system_principal_context_unavailable',
      reason: 'The system principal could not be revalidated',
    }),
    cause
  );

const DATABASE_OPERATION_TIMEOUT = Duration.seconds(30);

const loadSystemPrincipalContextRecord = <
  Result extends SystemPrincipalContextRepositoryLoadResult,
>(
  repository: SystemPrincipalContextRecordReader<Result>,
  input: { readonly principalId: string; readonly tenantId: string }
): Effect.Effect<
  Option.Option<SystemPrincipalContextRecord>,
  SystemPrincipalContextUnavailableError
> => repository.load(input);

const systemPrincipalContextRepositoryFromDatabase = (database: {
  readonly executor: Pick<CoreDatabaseExecutor, 'select'>;
}) => ({
  load: (input: { readonly principalId: string; readonly tenantId: string }) =>
    database.executor
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
          eq(principals.principalId, input.principalId)
        )
      )
      .limit(1)
      .pipe(
        Effect.mapError(unavailable),
        Effect.map(([loaded]) => Option.fromNullishOr(loaded)),
        Effect.timeoutOrElse({
          duration: DATABASE_OPERATION_TIMEOUT,
          orElse: () => Effect.fail(unavailable()),
        })
      ),
});

const isEligibleSystemPrincipal = (
  record: SystemPrincipalContextRecord,
  registration: SystemWorkloadRegistration
): boolean => {
  const kindAllowed =
    record.kind === 'system' ||
    (registration.allowServicePrincipal && record.kind === 'service');
  return (
    record.principalStatus === 'active' &&
    record.tenantStatus === 'active' &&
    kindAllowed
  );
};

export const systemPrincipalContextResolverFromRepository = <
  Result extends SystemPrincipalContextRepositoryLoadResult,
>(
  repository: SystemPrincipalContextRecordReader<Result>
) => ({
  resolve: Effect.fn('systemPrincipalContextResolverFromRepository.resolve')(
    function* resolveSystemPrincipalContext(input: {
      readonly principalId: string;
      readonly registration: SystemWorkloadRegistration;
      readonly runReference: string;
      readonly tenantId: string;
    }): Effect.fn.Return<TrustedPrincipalContext, SystemPrincipalContextError> {
      if (
        input.registration[registrationProvenance] !== true ||
        !safePart.test(input.runReference) ||
        !Schema.is(Schema.String.check(Schema.isUUID()))(input.tenantId) ||
        !Schema.is(Schema.String.check(Schema.isUUID()))(input.principalId)
      ) {
        return yield* new SystemPrincipalContextInvalidError({
          code: 'system_principal_context_invalid',
          reason: 'The trusted system workload registration is invalid',
        });
      }
      const maybeRecord = yield* loadSystemPrincipalContextRecord(repository, {
        principalId: input.principalId,
        tenantId: input.tenantId,
      });
      if (Option.isNone(maybeRecord)) {
        return yield* new SystemPrincipalContextDeniedError({
          code: 'system_principal_context_denied',
          reason:
            'The configured system principal is not active and eligible in this tenant',
        });
      }
      const record = maybeRecord.value;
      if (!isEligibleSystemPrincipal(record, input.registration)) {
        return yield* new SystemPrincipalContextDeniedError({
          code: 'system_principal_context_denied',
          reason:
            'The configured system principal is not active and eligible in this tenant',
        });
      }
      return trustResolvedSystemPrincipalContext(
        Object.freeze({
          authContextRef: `job:${input.registration.jobKey}:run:${input.runReference}`,
          authMethod: 'system' as const,
          principalId: input.principalId,
          tenantId: input.tenantId,
        })
      );
    }
  ),
});

export const makeSystemPrincipalContextResolver = (database: {
  readonly executor: Pick<CoreDatabaseExecutor, 'select'>;
}) =>
  systemPrincipalContextResolverFromRepository(
    systemPrincipalContextRepositoryFromDatabase(database)
  );
