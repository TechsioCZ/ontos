import { Effect, Option } from 'effect';
import type { Schema } from 'effect';

import {
  ExternalIdentityError,
  ReadPrincipalBindingPayloadSchema,
  ReadPrincipalBindingResultSchema,
} from '../external-identity-contracts.ts';
import {
  authenticationNamespaceRegistration,
  externalIdentityRepositoryFromTransaction,
  principalBindingReadResult,
} from './repository.ts';
import type {
  ExternalIdentityBindingRecord,
  ExternalIdentityRepositoryService,
  PrincipalBindingLookup,
} from './repository.ts';
import { AuthenticationNamespaceRegistry } from './verifier.ts';
import { externalIdentityFailure } from './errors.ts';
import type { ExternalIdentityFailure } from './errors.ts';
import { ContextAccess } from '../../permissions/context-access.ts';
import { defineSystemModuleEntrypoint } from '../../modules/module-entrypoint.ts';
import { defineRead } from '../../reads/definition.ts';
import type { ReadPermissionTargetResolver } from '../../reads/definition.ts';
import type { ReadFinishContext, ReadPrepareContext } from '../../reads/context.ts';
import type { OperationalScope } from '../../operations/context.ts';

export type ReadPrincipalBindingPayload = Schema.Schema.Type<typeof ReadPrincipalBindingPayloadSchema>;

type ReadPrincipalBindingServices = Readonly<{
  readonly loadForRead: ExternalIdentityRepositoryService['loadForRead'];
}>;

const permissionTargetResolver: ReadPermissionTargetResolver<ReadPrincipalBindingPayload> = () => ({
  kind: 'tenant',
  // Namespace provisioners have Tenant access but no administrative lifecycle
  // permission. The handler performs the exact namespace-or-admin check below.
  permission: 'access',
});

const decisionFor = (
  decisions: readonly { readonly decision: 'allowed' | 'denied' | 'unavailable'; readonly key: string }[],
  key: string,
): 'allowed' | 'denied' | 'unavailable' =>
  decisions.length === 1 && decisions[0]?.key === key ? decisions[0].decision : 'unavailable';

const authorizeReadNamespace = (
  contextAccess: Option.Option<(typeof ContextAccess)['Service']>,
  scope: OperationalScope,
  authenticationNamespaceId: string,
): Effect.Effect<void, ReturnType<typeof externalIdentityFailure>> => {
  if (Option.isNone(contextAccess) || contextAccess.value.identityNamespaces === undefined) {
    return Effect.fail(externalIdentityFailure('identity_unavailable', 'Identity namespace access is unavailable'));
  }
  return contextAccess.value
    .identityNamespaces({
      authenticationNamespaceIds: [authenticationNamespaceId],
      principalId: scope.principalId,
      tenantId: scope.tenantId,
    })
    .pipe(
      Effect.flatMap((namespaceDecisions) => {
        const namespaceDecision = decisionFor(namespaceDecisions, authenticationNamespaceId);
        if (namespaceDecision === 'allowed') {
          return Effect.void;
        }
        return contextAccess.value
          .tenants({
            permission: 'manage_identity',
            principalId: scope.principalId,
            tenantIds: [scope.tenantId],
          })
          .pipe(
            Effect.flatMap((tenantDecisions) =>
              decisionFor(tenantDecisions, scope.tenantId) === 'allowed'
                ? Effect.void
                : Effect.fail(
                    externalIdentityFailure(
                      namespaceDecision === 'denied' ? 'identity_forbidden' : 'identity_unavailable',
                      'The Actor is not authorized to read this identity namespace',
                    ),
                  ),
            ),
          );
      }),
    );
};

type ReadNamespaceAuthorization = (authenticationNamespaceId: string) => Effect.Effect<void, ExternalIdentityFailure>;

const namespaceAuthorization = (scope: OperationalScope) =>
  Effect.map(
    Effect.serviceOption(ContextAccess),
    (contextAccess): ReadNamespaceAuthorization =>
      (authenticationNamespaceId) =>
        authorizeReadNamespace(contextAccess, scope, authenticationNamespaceId),
  );

const registryDependencies = Effect.map(Effect.serviceOption(AuthenticationNamespaceRegistry), (registry) =>
  Option.isSome(registry) ? { registry: registry.value } : {},
);

const readFailure = (failure: ExternalIdentityFailure) => new ExternalIdentityError({ code: failure.code });

/**
 * Before the transaction: a subject lookup authorizes the supplied namespace first, so a missing subject
 * cannot be told apart from one the caller may not read, and resolves the namespace's trusted provider.
 */
const prepare = Effect.fn('ReadPrincipalBinding.prepare')(function* preparePrincipalBindingRead(
  input: ReadPrincipalBindingPayload,
  context: ReadPrepareContext,
) {
  if (input.lookup === 'binding') {
    return {
      lookup: { authBindingId: input.authBindingId, lookup: 'binding', tenantId: context.scope.tenantId },
    } satisfies PreparedLookup;
  }
  const authorize = yield* namespaceAuthorization(context.scope);
  yield* authorize(input.authenticationNamespaceId);
  const registration = yield* authenticationNamespaceRegistration(
    yield* registryDependencies,
    input.authenticationNamespaceId,
  );
  return {
    authorizedNamespaceId: input.authenticationNamespaceId,
    lookup: {
      authenticationNamespaceId: input.authenticationNamespaceId,
      lookup: 'subject',
      provider: registration.provider,
      providerSubjectId: input.providerSubjectId,
      subjectType: input.subjectType,
      tenantId: context.scope.tenantId,
    },
  } satisfies PreparedLookup;
}, Effect.mapError(readFailure));

interface PreparedLookup {
  /** The namespace `prepare` already authorized (subject lookups). */
  readonly authorizedNamespaceId?: string;
  readonly lookup: PrincipalBindingLookup;
}

/**
 * After commit: binding identifiers are opaque, so a binding in a namespace the caller may not read is
 * normalized to the same result as an absent one.
 */
const finish = Effect.fn('ReadPrincipalBinding.finish')(
  function* finishPrincipalBindingRead(
    _input: ReadPrincipalBindingPayload,
    context: ReadFinishContext<PreparedLookup, Option.Option<ExternalIdentityBindingRecord>>,
  ) {
    if (Option.isNone(context.loaded)) {
      return { outcome: 'NOT_FOUND' as const };
    }
    const binding = context.loaded.value;
    if (binding.authenticationNamespaceId !== context.prepared.authorizedNamespaceId) {
      const authorize = yield* namespaceAuthorization(context.scope);
      const canRead = yield* authorize(binding.authenticationNamespaceId).pipe(
        Effect.as(true),
        Effect.catchIf(
          (failure) => failure.code === 'identity_forbidden',
          () => Effect.succeed(false),
        ),
      );
      if (!canRead) {
        return { outcome: 'NOT_FOUND' as const };
      }
    }
    return yield* principalBindingReadResult(yield* registryDependencies, binding);
  },
  Effect.mapError(readFailure),
  Effect.map((result) => ({ evidence: { resultCount: result.outcome === 'FOUND' ? 1 : 0 }, result })),
);

export const readPrincipalBinding = defineRead<
  typeof ReadPrincipalBindingPayloadSchema,
  typeof ReadPrincipalBindingResultSchema,
  'core.identity',
  ReadPrincipalBindingServices,
  ExternalIdentityError,
  never,
  typeof ExternalIdentityError,
  PreparedLookup,
  Option.Option<ExternalIdentityBindingRecord>,
  ExternalIdentityError,
  never,
  ExternalIdentityError
>(
  {
    accessKind: 'detail',
    domainErrorSchema: ExternalIdentityError,
    entrypoint: defineSystemModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'context_permission', permission: 'module.access' },
      entrypointKey: 'core.identity.read-principal-binding',
      moduleKey: 'core.identity',
      role: 'api',
    }),
    evidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: 'core.identity.read-principal-binding.access.v1',
    },
    inputSchema: ReadPrincipalBindingPayloadSchema,
    legalEntityScope: 'forbidden',
    owningModuleKey: 'core.identity',
    permissionTarget: 'tenant',
    policies: [],
    readKey: 'core.identity.read-principal-binding',
    resultSchema: ReadPrincipalBindingResultSchema,
    schemaVersion: '1',
  },
  {
    // oxlint-disable perfectionist/sort-objects -- Read steps stay in execution order; each step's types infer from the previous one.
    prepare,
    load: (_input, context) => context.services.loadForRead(context.prepared.lookup).pipe(Effect.mapError(readFailure)),
    finish,
    // oxlint-enable perfectionist/sort-objects
  },
  (transaction) => Effect.succeed({ loadForRead: externalIdentityRepositoryFromTransaction(transaction).loadForRead }),
  permissionTargetResolver,
);
