// @effect-diagnostics asyncFunction:off
import { and, eq } from 'drizzle-orm';
import { Context, Effect, Layer, Schema, Predicate } from 'effect';
import { CoreDatabase } from '../db/client.ts';
import {
  actionInvocations,
  auditEvents,
  principalAuthBindings,
  principals,
  tenants,
} from '../db/schema.ts';
import type { PrincipalKind } from '../db/schema.ts';
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
  readonly principalKind: PrincipalKind;
  readonly principalId: string;
  readonly tenantId: string;
}

export interface ApiKeyBindingAdministration {
  readonly providerSubjectId: string;
  readonly status: 'active' | 'disabled' | 'revoked';
}

export const ProviderSubjectSchema = Schema.Struct({
  provider: Schema.Literal('better_auth'),
  providerSubjectId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  subjectType: Schema.Literals(['user', 'api_key']),
});
export type ProviderSubject = Schema.Schema.Type<typeof ProviderSubjectSchema>;

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

export interface PrincipalResolutionRecordRepository {
  readonly load: (
    subject: ProviderSubject,
    tenantId?: string,
  ) => Promise<readonly PrincipalResolutionRecord[]>;
}

const loadPrincipalResolutionRecords = (
  repository: PrincipalResolutionRecordRepository,
  subject: ProviderSubject,
  tenantId?: string,
): Effect.Effect<readonly PrincipalResolutionRecord[], PrincipalResolverUnavailableError> =>
  Effect.tryPromise({
    catch: () =>
      new PrincipalResolverUnavailableError({
        reason: 'Unable to resolve the authenticated principal',
      }),
    try: () => repository.load(subject, tenantId),
  });

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

export const listAvailableTenantsFromRepository = (
  repository: PrincipalResolutionRecordRepository,
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

export const classifyApiKeyPrincipal = (
  records: readonly PrincipalResolutionRecord[],
): Effect.Effect<ResolvedPrincipalIdentity, PrincipalResolutionError> =>
  Effect.gen(function* classifyApiKeyPrincipalEffect() {
    const eligible = yield* eligibleRecords(records);
    const [only] = eligible;
    if (eligible.length !== 1 || only === undefined) {
      return yield* new PrincipalBindingAmbiguousError();
    }
    if (!['human', 'service', 'integration'].includes(only.principalKind)) {
      return yield* new PrincipalInactiveError();
    }
    return toResolvedIdentity(only);
  });

export interface PrincipalResolverService {
  readonly resolveBetterAuthUserForPrincipal: (input: {
    readonly principalId: string;
    readonly tenantId: string;
  }) => Effect.Effect<string, PrincipalResolutionError>;
  readonly resolveApiKeyBindingSubject: (input: {
    readonly authBindingId: string;
    readonly principalId: string;
    readonly tenantId: string;
  }) => Effect.Effect<string, PrincipalResolutionError>;
  readonly loadApiKeyBindingForAdministration: (input: {
    readonly authBindingId: string;
    readonly principalId: string;
    readonly tenantId: string;
  }) => Effect.Effect<ApiKeyBindingAdministration, PrincipalResolutionError>;
  readonly listAvailableTenants: (
    betterAuthUserId: string,
  ) => Effect.Effect<readonly AvailableTenant[], PrincipalResolutionError>;
  readonly resolveDefaultBetterAuthUser: (
    betterAuthUserId: string,
  ) => Effect.Effect<ResolvedPrincipalIdentity, PrincipalResolutionError>;
  readonly resolveBetterAuthUserForTenant: (
    betterAuthUserId: string,
    tenantId: string,
  ) => Effect.Effect<ResolvedPrincipalIdentity, PrincipalResolutionError>;
  readonly resolveBetterAuthApiKey: (
    betterAuthApiKeyId: string,
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

export const makePrincipalResolver = (
  database: (typeof CoreDatabase)['Service'],
): PrincipalResolverService => {
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
    Effect.tryPromise({
      catch: () =>
        new PrincipalResolverUnavailableError({
          reason: 'Unable to resolve the API key binding',
        }),
      try: async () => {
        const [record] = await database.executor
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
          .limit(1);
        return record;
      },
    });

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
      Effect.tryPromise({
        catch: () =>
          new PrincipalResolverUnavailableError({
            reason: 'Unable to resolve the principal provider subject',
          }),
        try: async () =>
          await database.executor
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
      }).pipe(
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
      Effect.tryPromise({
        catch: () =>
          new PrincipalResolverUnavailableError({
            reason: 'Unable to verify the support impersonation lifecycle',
          }),
        try: () =>
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
      }).pipe(
        Effect.map((records) =>
          records.some(({ evidence }) => {
            if (!Predicate.isObjectKeyword(evidence) || evidence === null) {
              return false;
            }
            return (
              'checkpoint' in evidence &&
              evidence.checkpoint === 'started' &&
              'originalPrincipalId' in evidence &&
              evidence.originalPrincipalId === input.originalPrincipalId &&
              'reason' in evidence &&
              evidence.reason === input.reason &&
              'targetPrincipalId' in evidence &&
              evidence.targetPrincipalId === input.targetPrincipalId &&
              'sessionRef' in evidence &&
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
