import { and, eq } from 'drizzle-orm';
import { Context, Duration, Effect, Layer, Option, Schema } from 'effect';
import type { TrustedPrincipalContext } from '../actions/principal-context.ts';
import { CoreDatabase } from '../db/client.ts';
import { principalAuthBindings, principals, tenants } from '../db/schema.ts';
import type { CoreDatabaseExecutor } from '../db/types.ts';
import { recordSupportImpersonationAction } from '../modules/actions/record-support-impersonation.action.ts';
import { SupportRecoveryPrincipalContextDeniedError } from './support-recovery-principal-context-denied-error.ts';
import { SupportRecoveryPrincipalContextUnavailableError } from './support-recovery-principal-context-unavailable-error.ts';
import { trustSupportRecoveryPrincipalContext } from './system-principal-context-provenance.ts';

export { SupportRecoveryPrincipalContextDeniedError } from './support-recovery-principal-context-denied-error.ts';
export { SupportRecoveryPrincipalContextUnavailableError } from './support-recovery-principal-context-unavailable-error.ts';

const uuid = Schema.String.check(Schema.isUUID());

export type SupportRecoveryPrincipalContextError =
  | SupportRecoveryPrincipalContextDeniedError
  | SupportRecoveryPrincipalContextUnavailableError;

export interface SupportRecoveryPrincipalContextResolverService {
  readonly resolveStoppedImpersonation: (input: {
    readonly originalAuthBindingId: string;
    readonly originalPrincipalId: string;
    readonly originalSessionId: string;
    readonly tenantId: string;
  }) => Effect.Effect<TrustedPrincipalContext, SupportRecoveryPrincipalContextError>;
}

interface SupportRecoveryPrincipalContextRecord {
  readonly bindingPrincipalId: string;
  readonly bindingTenantId: string;
  readonly principalKind: (typeof principals.$inferSelect)['kind'];
  readonly principalTenantId: string;
  readonly tenantId: string;
}

interface SupportRecoveryPrincipalContextRepositoryInput {
  readonly originalAuthBindingId: string;
  readonly originalPrincipalId: string;
  readonly tenantId: string;
}

type SupportRecoveryPrincipalContextRepositoryLoadResult = Effect.Effect<
  Option.Option<SupportRecoveryPrincipalContextRecord>,
  SupportRecoveryPrincipalContextUnavailableError
>;

interface SupportRecoveryPrincipalContextRecordReader<
  Result extends SupportRecoveryPrincipalContextRepositoryLoadResult,
> {
  readonly load: (input: SupportRecoveryPrincipalContextRepositoryInput) => Result;
}

interface SupportRecoveryPrincipalContextEffectRecordReader {
  readonly load: (
    input: SupportRecoveryPrincipalContextRepositoryInput,
  ) => Effect.Effect<
    Option.Option<SupportRecoveryPrincipalContextRecord>,
    SupportRecoveryPrincipalContextUnavailableError
  >;
}

const attachCause = <Failure extends object>(failure: Failure, cause: unknown): Failure =>
  cause === undefined ? failure : Object.defineProperty(failure, 'cause', { value: cause });

const unavailable = (cause?: unknown): SupportRecoveryPrincipalContextUnavailableError =>
  attachCause(
    new SupportRecoveryPrincipalContextUnavailableError({
      code: 'support_recovery_context_unavailable',
      reason: 'The support recovery identity could not be revalidated',
    }),
    cause,
  );

const DATABASE_OPERATION_TIMEOUT = Duration.seconds(30);

const supportRecoveryPrincipalContextRepositoryFromDatabase = (database: {
  readonly executor: Pick<CoreDatabaseExecutor, 'select'>;
}): SupportRecoveryPrincipalContextEffectRecordReader => ({
  load: (input: SupportRecoveryPrincipalContextRepositoryInput) =>
    database.executor
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
      .limit(1)
      .pipe(
        Effect.mapError(unavailable),
        Effect.map(([loaded]) => Option.fromNullishOr(loaded)),
        Effect.timeoutOrElse({
          duration: DATABASE_OPERATION_TIMEOUT,
          orElse: () => Effect.fail(unavailable()),
        }),
      ),
});

const isInvalidRecoveryInput = (
  input: Parameters<
    SupportRecoveryPrincipalContextResolverService['resolveStoppedImpersonation']
  >[0],
): boolean =>
  !Schema.is(uuid)(input.originalAuthBindingId) ||
  !Schema.is(uuid)(input.originalPrincipalId) ||
  !Schema.is(uuid)(input.tenantId) ||
  input.originalSessionId.length === 0 ||
  input.originalSessionId.length > 280 ||
  /\s/u.test(input.originalSessionId);

const supportRecoveryPrincipalContextResolverFromEffectRecordReader = (
  repository: SupportRecoveryPrincipalContextEffectRecordReader,
): SupportRecoveryPrincipalContextResolverService => ({
  resolveStoppedImpersonation: Effect.fn(
    'SupportRecoveryPrincipalContext.resolveStoppedImpersonation',
  )(function* resolveStoppedImpersonation(input): Effect.fn.Return<
    TrustedPrincipalContext,
    SupportRecoveryPrincipalContextError
  > {
    if (isInvalidRecoveryInput(input)) {
      return yield* new SupportRecoveryPrincipalContextDeniedError({
        code: 'support_recovery_context_denied',
        reason: 'The support recovery identity is invalid',
      });
    }
    const maybeRecord = yield* repository.load({
      originalAuthBindingId: input.originalAuthBindingId,
      originalPrincipalId: input.originalPrincipalId,
      tenantId: input.tenantId,
    });
    if (Option.isNone(maybeRecord)) {
      return yield* new SupportRecoveryPrincipalContextDeniedError({
        code: 'support_recovery_context_denied',
        reason: 'The support recovery identity is not a historical tenant-local user binding',
      });
    }
    const record = maybeRecord.value;
    if (
      record.bindingPrincipalId !== input.originalPrincipalId ||
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

export const supportRecoveryPrincipalContextResolverFromRepository = (
  repository: SupportRecoveryPrincipalContextRecordReader<SupportRecoveryPrincipalContextRepositoryLoadResult>,
): SupportRecoveryPrincipalContextResolverService =>
  supportRecoveryPrincipalContextResolverFromEffectRecordReader(repository);

export const makeSupportRecoveryPrincipalContextResolver = (database: {
  readonly executor: Pick<CoreDatabaseExecutor, 'select'>;
}): SupportRecoveryPrincipalContextResolverService =>
  supportRecoveryPrincipalContextResolverFromEffectRecordReader(
    supportRecoveryPrincipalContextRepositoryFromDatabase(database),
  );

export class SupportRecoveryPrincipalContextResolver extends Context.Service<
  SupportRecoveryPrincipalContextResolver,
  SupportRecoveryPrincipalContextResolverService
>()(
  '@app/core-runtime/auth/support-recovery-principal-context/SupportRecoveryPrincipalContextResolver',
) {}

export const SupportRecoveryPrincipalContextResolverLive = Layer.effect(
  SupportRecoveryPrincipalContextResolver,
  CoreDatabase.pipe(Effect.map(makeSupportRecoveryPrincipalContextResolver)),
);
