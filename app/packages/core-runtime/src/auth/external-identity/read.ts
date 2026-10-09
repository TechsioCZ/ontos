import { Effect, Option } from 'effect';
import type { Schema } from 'effect';

import {
  ExternalIdentityError,
  ReadPrincipalBindingPayloadSchema,
  ReadPrincipalBindingResultSchema,
} from '../external-identity-contracts.ts';
import { externalIdentityRepositoryFromTransaction } from './repository.ts';
import type { ExternalIdentityRepositoryService } from './repository.ts';
import { AuthenticationNamespaceRegistry } from './verifier.ts';
import { externalIdentityFailure } from './errors.ts';
import { ContextAccess } from '../../permissions/context-access.ts';
import { defineSystemModuleEntrypoint } from '../../modules/module-entrypoint.ts';
import { defineRead } from '../../reads/definition.ts';
import type { ReadPermissionTargetResolver } from '../../reads/definition.ts';
import type { ReadHandlerContext } from '../../reads/context.ts';
import type { OperationalScope } from '../../operations/context.ts';

export type ReadPrincipalBindingPayload = Schema.Schema.Type<typeof ReadPrincipalBindingPayloadSchema>;

type ReadPrincipalBindingServices = Readonly<{
  readonly read: ExternalIdentityRepositoryService['read'];
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

const handle = (input: ReadPrincipalBindingPayload, context: ReadHandlerContext<ReadPrincipalBindingServices>) => {
  const readInput =
    input.lookup === 'binding'
      ? {
          authBindingId: input.authBindingId,
          lookup: 'binding' as const,
          tenantId: context.scope.tenantId,
        }
      : {
          authenticationNamespaceId: input.authenticationNamespaceId,
          lookup: 'subject' as const,
          providerSubjectId: input.providerSubjectId,
          subjectType: input.subjectType,
          tenantId: context.scope.tenantId,
        };
  return context.services.read(readInput).pipe(
    Effect.mapError((failure) => new ExternalIdentityError({ code: failure.code })),
    Effect.map((result) => ({
      evidence: { resultCount: result.outcome === 'FOUND' ? 1 : 0 },
      result,
    })),
  );
};

export const readPrincipalBinding = defineRead<
  typeof ReadPrincipalBindingPayloadSchema,
  typeof ReadPrincipalBindingResultSchema,
  'core.identity',
  ReadPrincipalBindingServices,
  ExternalIdentityError,
  never,
  typeof ExternalIdentityError
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
  handle,
  Effect.fn('ReadPrincipalBinding.services')(function* makeServices(transaction, scope) {
    const registry = yield* Effect.serviceOption(AuthenticationNamespaceRegistry);
    const contextAccess = yield* Effect.serviceOption(ContextAccess);
    const dependencies = {
      authorizeReadNamespace: (authenticationNamespaceId: string) =>
        authorizeReadNamespace(contextAccess, scope, authenticationNamespaceId),
    };
    if (Option.isSome(registry)) {
      Object.assign(dependencies, { registry: registry.value });
    }
    const repository = externalIdentityRepositoryFromTransaction(transaction, dependencies);
    return { read: repository.read };
  }),
  permissionTargetResolver,
);
