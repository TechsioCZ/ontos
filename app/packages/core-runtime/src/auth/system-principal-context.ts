import { and, eq, or, sql } from 'drizzle-orm';
import { Context, Duration, Effect, Layer, Option, Schema } from 'effect';

import { TrustedPrincipalContextSchema } from '../actions/principal-context.ts';
import type { TrustedPrincipalContext } from '../actions/principal-context.ts';
import { CoreDatabase } from '../db/client.ts';
import { accessWorkloadBindings, principals, tenants } from '../db/schema.ts';
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
const invalidWorkloadRegistrationReason = 'The trusted system workload registration is invalid';
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

/** Returns a registered admission's native auth reference without constructing an authenticated principal. */
export const registeredAdmissionAuthContextRef = Effect.fn('registeredAdmissionAuthContextRef')(
  function* registeredAdmissionAuthContextRefEffect(
    registration: SystemWorkloadRegistration,
    actionInvocationId: string,
  ): Effect.fn.Return<string, SystemPrincipalContextInvalidError> {
    if (
      registration[registrationProvenance] !== true ||
      !Schema.is(Schema.String.check(Schema.isUUID()))(actionInvocationId)
    ) {
      return yield* new SystemPrincipalContextInvalidError({
        code: 'system_principal_context_invalid',
        reason: invalidWorkloadRegistrationReason,
      });
    }
    return `job:${registration.jobKey}:run:${actionInvocationId}`;
  },
);

interface SystemPrincipalContextRecord {
  readonly kind: (typeof principals.$inferSelect)['kind'];
  readonly principalStatus: (typeof principals.$inferSelect)['status'];
  readonly tenantStatus: (typeof tenants.$inferSelect)['status'];
}

type SystemPrincipalContextRepositoryLoadResult = Effect.Effect<
  Option.Option<SystemPrincipalContextRecord>,
  SystemPrincipalContextUnavailableError
>;

interface SystemPrincipalContextRecordReader<Result extends SystemPrincipalContextRepositoryLoadResult> {
  readonly load: (input: { readonly principalId: string; readonly tenantId: string }) => Result;
  readonly loadEnrolled?: (input: {
    readonly allowServicePrincipal: boolean;
    readonly jobKey: string;
    readonly tenantId: string;
  }) => Effect.Effect<readonly { readonly principalId: string }[], SystemPrincipalContextUnavailableError>;
}

const unavailable = (cause?: unknown): SystemPrincipalContextUnavailableError =>
  new SystemPrincipalContextUnavailableError({
    cause,
    code: 'system_principal_context_unavailable',
    reason: 'The system principal could not be revalidated',
  });

const DATABASE_OPERATION_TIMEOUT = Duration.seconds(30);

const loadSystemPrincipalContextRecord = <Result extends SystemPrincipalContextRepositoryLoadResult>(
  repository: SystemPrincipalContextRecordReader<Result>,
  input: { readonly principalId: string; readonly tenantId: string },
): Effect.Effect<Option.Option<SystemPrincipalContextRecord>, SystemPrincipalContextUnavailableError> =>
  repository.load(input);

const systemPrincipalContextRepositoryFromDatabase = (database: {
  readonly executor: Pick<CoreDatabaseExecutor, 'select' | 'transaction'>;
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
      .where(and(eq(principals.tenantId, input.tenantId), eq(principals.principalId, input.principalId)))
      .limit(1)
      .pipe(
        Effect.mapError(unavailable),
        Effect.map(([loaded]) => Option.fromNullishOr(loaded)),
        Effect.timeoutOrElse({
          duration: DATABASE_OPERATION_TIMEOUT,
          orElse: () => Effect.fail(unavailable()),
        }),
      ),
  loadEnrolled: (input: {
    readonly allowServicePrincipal: boolean;
    readonly jobKey: string;
    readonly tenantId: string;
  }) =>
    database.executor
      .transaction(
        Effect.fn('SystemPrincipalContextRepository.loadEnrolled')(function* enrolled(transaction) {
          yield* transaction.execute(
            sql`select set_config('ontos.tenant_id', ${input.tenantId}, true), set_config('ontos.legal_entity_id', '', true)`,
            'objects',
          );
          return yield* transaction
            .select({ principalId: principals.principalId })
            .from(accessWorkloadBindings)
            .innerJoin(
              principals,
              and(
                eq(principals.tenantId, accessWorkloadBindings.tenantId),
                eq(principals.principalId, accessWorkloadBindings.principalId),
              ),
            )
            .innerJoin(tenants, eq(tenants.tenantId, principals.tenantId))
            .where(
              and(
                eq(accessWorkloadBindings.tenantId, input.tenantId),
                eq(accessWorkloadBindings.workloadKey, input.jobKey),
                eq(accessWorkloadBindings.status, 'active'),
                eq(principals.status, 'active'),
                eq(tenants.status, 'active'),
                input.allowServicePrincipal
                  ? or(eq(principals.kind, 'system'), eq(principals.kind, 'service'))
                  : eq(principals.kind, 'system'),
              ),
            )
            .limit(2);
        }),
      )
      .pipe(
        Effect.mapError(unavailable),
        Effect.timeoutOrElse({ duration: DATABASE_OPERATION_TIMEOUT, orElse: () => Effect.fail(unavailable()) }),
      ),
});

const isEligibleSystemPrincipal = (
  record: SystemPrincipalContextRecord,
  registration: SystemWorkloadRegistration,
): boolean => {
  const kindAllowed = record.kind === 'system' || (registration.allowServicePrincipal && record.kind === 'service');
  return record.principalStatus === 'active' && record.tenantStatus === 'active' && kindAllowed;
};

export const systemPrincipalContextResolverFromRepository = <Result extends SystemPrincipalContextRepositoryLoadResult>(
  repository: SystemPrincipalContextRecordReader<Result>,
) => {
  const resolve = Effect.fn('systemPrincipalContextResolverFromRepository.resolve')(
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
          reason: invalidWorkloadRegistrationReason,
        });
      }
      const maybeRecord = yield* loadSystemPrincipalContextRecord(repository, {
        principalId: input.principalId,
        tenantId: input.tenantId,
      });
      if (Option.isNone(maybeRecord)) {
        return yield* new SystemPrincipalContextDeniedError({
          code: 'system_principal_context_denied',
          reason: 'The configured system principal is not active and eligible in this tenant',
        });
      }
      const record = maybeRecord.value;
      if (!isEligibleSystemPrincipal(record, input.registration)) {
        return yield* new SystemPrincipalContextDeniedError({
          code: 'system_principal_context_denied',
          reason: 'The configured system principal is not active and eligible in this tenant',
        });
      }
      const context = yield* Schema.decodeEffect(TrustedPrincipalContextSchema)({
        authContextRef: `job:${input.registration.jobKey}:run:${input.runReference}`,
        authMethod: 'system',
        principalId: input.principalId,
        tenantId: input.tenantId,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new SystemPrincipalContextInvalidError({
              cause,
              code: 'system_principal_context_invalid',
              reason: invalidWorkloadRegistrationReason,
            }),
        ),
      );
      return trustResolvedSystemPrincipalContext(Object.freeze(context));
    },
  );
  return {
    resolve,
    resolveEnrolled: Effect.fn('SystemPrincipalContextResolver.resolveEnrolled')(function* resolveEnrolled(input: {
      readonly registration: SystemWorkloadRegistration;
      readonly runReference: string;
      readonly tenantId: string;
    }): Effect.fn.Return<TrustedPrincipalContext, SystemPrincipalContextError> {
      if (
        input.registration[registrationProvenance] !== true ||
        !safePart.test(input.runReference) ||
        !Schema.is(Schema.String.check(Schema.isUUID()))(input.tenantId)
      ) {
        return yield* new SystemPrincipalContextInvalidError({
          code: 'system_principal_context_invalid',
          reason: invalidWorkloadRegistrationReason,
        });
      }
      if (repository.loadEnrolled === undefined) {
        return yield* unavailable();
      }
      const enrolled = yield* repository.loadEnrolled({
        allowServicePrincipal: input.registration.allowServicePrincipal,
        jobKey: input.registration.jobKey,
        tenantId: input.tenantId,
      });
      const [principal] = enrolled;
      if (enrolled.length !== 1 || principal === undefined) {
        return yield* new SystemPrincipalContextDeniedError({
          code: 'system_principal_context_denied',
          reason: 'The tenant workload must have exactly one eligible enrolled system principal',
        });
      }
      return yield* resolve({ ...input, principalId: principal.principalId });
    }),
  };
};

export const makeSystemPrincipalContextResolver = (database: {
  readonly executor: Pick<CoreDatabaseExecutor, 'select' | 'transaction'>;
}) => systemPrincipalContextResolverFromRepository(systemPrincipalContextRepositoryFromDatabase(database));

/** Public identity capability. Database construction stays inside Core infrastructure. */
export class SystemPrincipalContextResolver extends Context.Service<
  SystemPrincipalContextResolver,
  ReturnType<typeof makeSystemPrincipalContextResolver>
>()('@app/core-runtime/auth/system-principal-context/SystemPrincipalContextResolver') {}

/** The resolver over the Core database the surrounding layers provide, for Core code already inside them. */
export const SystemPrincipalContextResolverFromCoreDatabase = CoreDatabase.pipe(
  Effect.map(makeSystemPrincipalContextResolver),
);

export const SystemPrincipalContextResolverLive = Layer.effect(
  SystemPrincipalContextResolver,
  SystemPrincipalContextResolverFromCoreDatabase,
);
