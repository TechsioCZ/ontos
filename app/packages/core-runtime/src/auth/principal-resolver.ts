import { and, eq } from 'drizzle-orm';
import { Context, Duration, Effect, Layer, Schema } from 'effect';
import { CoreDatabase } from '../db/client.ts';
import {
  actionInvocations,
  auditEvents,
  principalAuthBindings,
  principals,
  tenants,
} from '../db/schema.ts';
import type { PrincipalKind } from '../db/schema.ts';
import type { CoreDatabaseExecutor } from '../db/types.ts';
import {
  PrincipalBindingAmbiguousError,
  PrincipalBindingInactiveError,
  PrincipalBindingMissingError,
  PrincipalInactiveError,
  PrincipalResolverUnavailableError,
  TenantInactiveError,
} from './principal-resolver-errors.ts';
import type { PrincipalResolutionError } from './principal-resolver-errors.ts';

export interface AvailableTenant {
  readonly name: string;
  readonly tenantId: string;
}

export interface ResolvedPrincipalIdentity {
  readonly authBindingId: string;
  readonly displayName: string;
  readonly principalId: string;
  readonly principalKind: PrincipalKind;
  readonly tenantId: string;
}

export interface ApiKeyBindingAdministration {
  readonly providerSubjectId: string;
  readonly status: 'active' | 'disabled' | 'revoked';
}

const ProviderSubjectIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(500),
).pipe(Schema.brand('ProviderSubjectId'));

export const ProviderSubjectSchema = Schema.Struct({
  provider: Schema.Literal('better_auth'),
  providerSubjectId: ProviderSubjectIdSchema,
  subjectType: Schema.Literals(['user', 'api_key']),
});

export interface ProviderSubject {
  readonly provider: 'better_auth';
  readonly providerSubjectId: string;
  readonly subjectType: 'api_key' | 'user';
}

const EvidencePrincipalIdSchema = Schema.String.pipe(Schema.brand('PrincipalId'));
const SupportImpersonationStartedEvidenceSchema = Schema.Struct({
  checkpoint: Schema.Literal('started'),
  originalPrincipalId: EvidencePrincipalIdSchema,
  reason: Schema.String,
  sessionRef: Schema.String,
  targetPrincipalId: EvidencePrincipalIdSchema,
});

export interface PrincipalResolutionRecord {
  readonly authBindingId: string;
  readonly bindingCreatedAt: Date;
  readonly bindingRevokedAt: Date | null;
  readonly bindingStatus: string;
  readonly displayName: string;
  readonly principalId: string;
  readonly principalKind: PrincipalKind;
  readonly principalStatus: string;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly tenantStatus: string;
}

type PrincipalResolutionRecordLoadResult = PromiseLike<readonly PrincipalResolutionRecord[]>;

interface PrincipalResolutionRecordReader<Result extends PrincipalResolutionRecordLoadResult> {
  readonly load: (subject: ProviderSubject, tenantId?: string) => Result;
}

export type PrincipalResolutionRecordRepository = PrincipalResolutionRecordReader<
  Promise<readonly PrincipalResolutionRecord[]>
>;

const attachCause = <Failure extends object>(failure: Failure, cause: unknown): Failure =>
  cause === undefined ? failure : Object.defineProperty(failure, 'cause', { value: cause });

const unavailable = (reason: string, cause?: unknown): PrincipalResolverUnavailableError =>
  attachCause(new PrincipalResolverUnavailableError({ reason }), cause);

const DATABASE_OPERATION_TIMEOUT = Duration.seconds(30);

const databaseOperation = <Value>(reason: string, operation: () => PromiseLike<Value>) =>
  Effect.tryPromise({
    catch: (cause) => unavailable(reason, cause),
    try: operation,
  }).pipe(
    Effect.timeoutOrElse({
      duration: DATABASE_OPERATION_TIMEOUT,
      orElse: () => Effect.fail(unavailable(reason)),
    }),
  );

const loadPrincipalResolutionRecords = <Result extends PrincipalResolutionRecordLoadResult>(
  repository: PrincipalResolutionRecordReader<Result>,
  subject: ProviderSubject,
  tenantId?: string,
): Effect.Effect<readonly PrincipalResolutionRecord[], PrincipalResolverUnavailableError> =>
  databaseOperation('Unable to resolve the authenticated principal', () =>
    repository.load(subject, tenantId),
  );

const compareText = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

const eligibleRecords = (
  records: readonly PrincipalResolutionRecord[],
): Effect.Effect<readonly PrincipalResolutionRecord[], PrincipalResolutionError> => {
  if (records.length === 0) {
    return Effect.fail(new PrincipalBindingMissingError());
  }

  const activeBindings = records.filter(
    (record) => record.bindingStatus === 'active' && record.bindingRevokedAt === null,
  );
  if (activeBindings.length === 0) {
    return Effect.fail(new PrincipalBindingInactiveError());
  }

  const activePrincipals = activeBindings.filter((record) => record.principalStatus === 'active');
  if (activePrincipals.length === 0) {
    return Effect.fail(new PrincipalInactiveError());
  }

  const activeTenants = activePrincipals.filter((record) => record.tenantStatus === 'active');
  if (activeTenants.length === 0) {
    return Effect.fail(new TenantInactiveError());
  }

  const tenantIds = new Set(activeTenants.map((record) => record.tenantId));
  if (tenantIds.size !== activeTenants.length) {
    return Effect.fail(new PrincipalBindingAmbiguousError());
  }

  return Effect.succeed(activeTenants);
};

const toResolvedIdentity = (record: PrincipalResolutionRecord): ResolvedPrincipalIdentity => ({
  authBindingId: record.authBindingId,
  displayName: record.displayName,
  principalId: record.principalId,
  principalKind: record.principalKind,
  tenantId: record.tenantId,
});

const eligibleHumanRecords = (
  records: readonly PrincipalResolutionRecord[],
): Effect.Effect<readonly PrincipalResolutionRecord[], PrincipalResolutionError> =>
  eligibleRecords(records).pipe(
    Effect.flatMap((eligible) => {
      const humans = eligible.filter((record) => record.principalKind === 'human');
      return humans.length === 0
        ? Effect.fail(new PrincipalInactiveError())
        : Effect.succeed(humans);
    }),
  );

export const classifyAvailableTenants = (
  records: readonly PrincipalResolutionRecord[],
): Effect.Effect<readonly AvailableTenant[], PrincipalResolutionError> =>
  eligibleHumanRecords(records).pipe(
    Effect.map((eligible) =>
      eligible
        .map((record) => ({ name: record.tenantName, tenantId: record.tenantId }))
        .toSorted(
          (left, right) =>
            compareText(left.name, right.name) || compareText(left.tenantId, right.tenantId),
        ),
    ),
  );

export const listAvailableTenantsFromRepository = <
  Result extends PrincipalResolutionRecordLoadResult,
>(
  repository: PrincipalResolutionRecordReader<Result>,
  betterAuthUserId: string,
): Effect.Effect<readonly AvailableTenant[], PrincipalResolutionError> =>
  loadPrincipalResolutionRecords(repository, {
    provider: 'better_auth',
    providerSubjectId: betterAuthUserId,
    subjectType: 'user',
  }).pipe(Effect.flatMap(classifyAvailableTenants));

export const classifyDefaultPrincipal = (
  records: readonly PrincipalResolutionRecord[],
): Effect.Effect<ResolvedPrincipalIdentity, PrincipalResolutionError> =>
  eligibleHumanRecords(records).pipe(
    Effect.map((eligible) =>
      eligible.toSorted(
        (left, right) =>
          left.bindingCreatedAt.getTime() - right.bindingCreatedAt.getTime() ||
          compareText(left.tenantId, right.tenantId),
      ),
    ),
    Effect.flatMap(([first]) =>
      first === undefined
        ? Effect.fail(new PrincipalBindingMissingError())
        : Effect.succeed(toResolvedIdentity(first)),
    ),
  );

export const classifySelectedPrincipal = (
  records: readonly PrincipalResolutionRecord[],
  selectedTenantId: string,
): Effect.Effect<ResolvedPrincipalIdentity, PrincipalResolutionError> =>
  eligibleHumanRecords(records).pipe(
    Effect.flatMap((eligible) => {
      const selected = eligible.find((record) => record.tenantId === selectedTenantId);
      return selected === undefined
        ? Effect.fail(new PrincipalBindingMissingError())
        : Effect.succeed(toResolvedIdentity(selected));
    }),
  );

export const classifyApiKeyPrincipal = Effect.fn('PrincipalResolver.classifyApiKeyPrincipal')(
  function* classifyApiKeyPrincipalEffect(records: readonly PrincipalResolutionRecord[]) {
    const eligible = yield* eligibleRecords(records);
    const [only] = eligible;
    if (eligible.length !== 1 || only === undefined) {
      return yield* new PrincipalBindingAmbiguousError();
    }
    if (!['human', 'service', 'integration'].includes(only.principalKind)) {
      return yield* new PrincipalInactiveError();
    }
    return toResolvedIdentity(only);
  },
);

export interface PrincipalResolverService {
  readonly listAvailableTenants: (
    betterAuthUserId: string,
  ) => Effect.Effect<readonly AvailableTenant[], PrincipalResolutionError>;
  readonly loadApiKeyBindingForAdministration: (input: {
    readonly authBindingId: string;
    readonly principalId: string;
    readonly tenantId: string;
  }) => Effect.Effect<ApiKeyBindingAdministration, PrincipalResolutionError>;
  readonly resolveApiKeyBindingSubject: (input: {
    readonly authBindingId: string;
    readonly principalId: string;
    readonly tenantId: string;
  }) => Effect.Effect<string, PrincipalResolutionError>;
  readonly resolveBetterAuthApiKey: (
    betterAuthApiKeyId: string,
  ) => Effect.Effect<ResolvedPrincipalIdentity, PrincipalResolutionError>;
  readonly resolveBetterAuthUserForPrincipal: (input: {
    readonly principalId: string;
    readonly tenantId: string;
  }) => Effect.Effect<string, PrincipalResolutionError>;
  readonly resolveBetterAuthUserForTenant: (
    betterAuthUserId: string,
    tenantId: string,
  ) => Effect.Effect<ResolvedPrincipalIdentity, PrincipalResolutionError>;
  readonly resolveDefaultBetterAuthUser: (
    betterAuthUserId: string,
  ) => Effect.Effect<ResolvedPrincipalIdentity, PrincipalResolutionError>;
  readonly resolveProviderSubject: (
    subject: ProviderSubject,
    tenantId?: string,
  ) => Effect.Effect<ResolvedPrincipalIdentity, PrincipalResolutionError>;
  readonly verifySupportImpersonationStarted: (input: {
    readonly actionId: string;
    readonly originalPrincipalId: string;
    readonly reason: string;
    readonly sessionId: string;
    readonly targetPrincipalId: string;
    readonly tenantId: string;
  }) => Effect.Effect<boolean, PrincipalResolverUnavailableError>;
}

export class PrincipalResolver extends Context.Service<
  PrincipalResolver,
  PrincipalResolverService
>()('@app/core-runtime/auth/principal-resolver/PrincipalResolver') {}

export const makePrincipalResolver = (database: {
  readonly executor: CoreDatabaseExecutor;
}): PrincipalResolverService => {
  const recordRepository: PrincipalResolutionRecordRepository = {
    load: (subject, tenantId) =>
      database.executor
        .select({
          authBindingId: principalAuthBindings.principalAuthBindingId,
          bindingCreatedAt: principalAuthBindings.createdAt,
          bindingRevokedAt: principalAuthBindings.revokedAt,
          bindingStatus: principalAuthBindings.status,
          displayName: principals.displayName,
          principalId: principals.principalId,
          principalKind: principals.kind,
          principalStatus: principals.status,
          tenantId: tenants.tenantId,
          tenantName: tenants.name,
          tenantStatus: tenants.status,
        })
        .from(principalAuthBindings)
        .innerJoin(
          principals,
          and(
            eq(principals.principalId, principalAuthBindings.principalId),
            eq(principals.tenantId, principalAuthBindings.tenantId),
          ),
        )
        .innerJoin(tenants, eq(tenants.tenantId, principalAuthBindings.tenantId))
        .where(
          and(
            eq(principalAuthBindings.provider, subject.provider),
            eq(principalAuthBindings.subjectType, subject.subjectType),
            eq(principalAuthBindings.providerSubjectId, subject.providerSubjectId),
            ...(tenantId === undefined ? [] : [eq(principalAuthBindings.tenantId, tenantId)]),
          ),
        ),
  };
  const loadRecords = (subject: ProviderSubject, tenantId?: string) =>
    loadPrincipalResolutionRecords(recordRepository, subject, tenantId);
  const loadApiKeyBindingSubject = (input: {
    readonly authBindingId: string;
    readonly principalId: string;
    readonly tenantId: string;
  }) =>
    databaseOperation('Unable to resolve the API key binding', () =>
      database.executor
        .select({
          providerSubjectId: principalAuthBindings.providerSubjectId,
          revokedAt: principalAuthBindings.revokedAt,
          status: principalAuthBindings.status,
        })
        .from(principalAuthBindings)
        .where(
          and(
            eq(principalAuthBindings.principalAuthBindingId, input.authBindingId),
            eq(principalAuthBindings.tenantId, input.tenantId),
            eq(principalAuthBindings.principalId, input.principalId),
            eq(principalAuthBindings.subjectType, 'api_key'),
          ),
        )
        .limit(1),
    ).pipe(Effect.map(([record]) => record));

  return {
    listAvailableTenants: (betterAuthUserId) =>
      listAvailableTenantsFromRepository(recordRepository, betterAuthUserId),
    loadApiKeyBindingForAdministration: (input) =>
      loadApiKeyBindingSubject(input).pipe(
        Effect.flatMap(
          (record): Effect.Effect<ApiKeyBindingAdministration, PrincipalBindingMissingError> =>
            record === undefined
              ? Effect.fail(new PrincipalBindingMissingError())
              : Effect.succeed({
                  providerSubjectId: record.providerSubjectId,
                  status: record.status,
                }),
        ),
      ),
    resolveApiKeyBindingSubject: (input) =>
      loadApiKeyBindingSubject(input).pipe(
        Effect.flatMap(
          (
            record,
          ): Effect.Effect<
            string,
            PrincipalBindingInactiveError | PrincipalBindingMissingError
          > => {
            if (record === undefined) {
              return Effect.fail(new PrincipalBindingMissingError());
            }
            if (record.status === 'revoked' || record.revokedAt !== null) {
              return Effect.fail(new PrincipalBindingInactiveError());
            }
            return Effect.succeed(record.providerSubjectId);
          },
        ),
      ),
    resolveBetterAuthApiKey: (betterAuthApiKeyId) =>
      loadRecords({
        provider: 'better_auth',
        providerSubjectId: betterAuthApiKeyId,
        subjectType: 'api_key',
      }).pipe(Effect.flatMap(classifyApiKeyPrincipal)),
    resolveBetterAuthUserForPrincipal: (input) =>
      databaseOperation('Unable to resolve the principal provider subject', () =>
        database.executor
          .select({
            providerSubjectId: principalAuthBindings.providerSubjectId,
            revokedAt: principalAuthBindings.revokedAt,
            status: principalAuthBindings.status,
          })
          .from(principalAuthBindings)
          .innerJoin(
            principals,
            and(
              eq(principals.tenantId, principalAuthBindings.tenantId),
              eq(principals.principalId, principalAuthBindings.principalId),
            ),
          )
          .where(
            and(
              eq(principalAuthBindings.tenantId, input.tenantId),
              eq(principalAuthBindings.principalId, input.principalId),
              eq(principalAuthBindings.provider, 'better_auth'),
              eq(principalAuthBindings.subjectType, 'user'),
              eq(principals.kind, 'human'),
              eq(principals.status, 'active'),
            ),
          ),
      ).pipe(
        Effect.flatMap(
          (
            records,
          ): Effect.Effect<
            string,
            PrincipalBindingAmbiguousError | PrincipalBindingMissingError
          > => {
            const active = records.filter(
              (record) => record.status === 'active' && record.revokedAt === null,
            );
            if (active.length === 0) {
              return Effect.fail(new PrincipalBindingMissingError());
            }
            const [only] = active;
            if (active.length !== 1 || only === undefined) {
              return Effect.fail(new PrincipalBindingAmbiguousError());
            }
            return Effect.succeed(only.providerSubjectId);
          },
        ),
      ),
    resolveBetterAuthUserForTenant: (betterAuthUserId, tenantId) =>
      loadRecords(
        {
          provider: 'better_auth',
          providerSubjectId: betterAuthUserId,
          subjectType: 'user',
        },
        tenantId,
      ).pipe(Effect.flatMap((records) => classifySelectedPrincipal(records, tenantId))),
    resolveDefaultBetterAuthUser: (betterAuthUserId) =>
      loadRecords({
        provider: 'better_auth',
        providerSubjectId: betterAuthUserId,
        subjectType: 'user',
      }).pipe(Effect.flatMap(classifyDefaultPrincipal)),
    resolveProviderSubject: (subject, tenantId) =>
      loadRecords(subject, tenantId).pipe(
        Effect.flatMap((records) => {
          if (subject.subjectType === 'api_key') {
            return classifyApiKeyPrincipal(records);
          }
          if (tenantId === undefined) {
            return classifyDefaultPrincipal(records);
          }
          return classifySelectedPrincipal(records, tenantId);
        }),
      ),
    verifySupportImpersonationStarted: (input) =>
      databaseOperation('Unable to verify the support impersonation lifecycle', () =>
        database.executor
          .select({ evidence: auditEvents.evidenceJson })
          .from(actionInvocations)
          .innerJoin(
            auditEvents,
            and(
              eq(auditEvents.tenantId, actionInvocations.tenantId),
              eq(auditEvents.actionInvocationId, actionInvocations.actionInvocationId),
            ),
          )
          .where(
            and(
              eq(actionInvocations.tenantId, input.tenantId),
              eq(actionInvocations.principalId, input.originalPrincipalId),
              eq(actionInvocations.actionKey, 'core.identity.record-support-impersonation'),
              eq(actionInvocations.idempotencyKey, `${input.actionId}:started`),
              eq(actionInvocations.status, 'succeeded'),
              eq(auditEvents.eventType, 'action.executed'),
              eq(auditEvents.outcome, 'succeeded'),
            ),
          ),
      ).pipe(
        Effect.map((records) =>
          records.some(({ evidence }) => {
            if (!Schema.is(SupportImpersonationStartedEvidenceSchema)(evidence)) {
              return false;
            }
            return (
              evidence.checkpoint === 'started' &&
              evidence.originalPrincipalId === input.originalPrincipalId &&
              evidence.reason === input.reason &&
              evidence.targetPrincipalId === input.targetPrincipalId &&
              evidence.sessionRef === `better-auth-session:${input.sessionId}`
            );
          }),
        ),
      ),
  };
};

export const PrincipalResolverLive = Layer.effect(
  PrincipalResolver,
  CoreDatabase.pipe(Effect.map(makePrincipalResolver)),
);
