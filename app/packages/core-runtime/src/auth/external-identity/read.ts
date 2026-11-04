import { Effect, Option, Schema } from 'effect';

import {
  ExternalIdentityError,
  AuthenticationNamespaceIdSchema,
  AuthBindingIdSchema,
  ExternalAuthenticationSubjectSchema,
  ResolveExternalSubjectResultSchema,
  ReadPrincipalBindingPayloadSchema,
  ReadPrincipalBindingResultSchema,
} from '../external-identity-contracts.ts';
import { externalIdentityRepositoryFromTransaction, externalIdentitySubjectForBinding } from './repository.ts';
import { ExternalIdentityAdmission, resolveExternalSubjectFromTransaction } from './resolve.ts';
import type { ExternalAuthenticationSubject } from '../external-identity-contracts.ts';
import type { ExternalIdentityFailure } from './errors.ts';
import type { ExternalIdentityAdmissionContext, ExternalIdentityRepositoryService } from './repository.ts';
import { AuthenticationNamespaceRegistry } from './verifier.ts';
import { externalIdentityFailure } from './errors.ts';
import { ContextAccess } from '../../permissions/context-access.ts';
import { defineSystemModuleEntrypoint } from '../../modules/module-entrypoint.ts';
import { defineRead } from '../../reads/definition.ts';
import type { ReadPermissionTargetResolver } from '../../reads/definition.ts';
import type { ReadHandlerContext } from '../../reads/context.ts';
import type { OperationalScope } from '../../operations/context.ts';

const CORE_IDENTITY_MODULE_KEY = 'core.identity';
const MODULE_ACCESS_PERMISSION = 'module.access';

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
      authorization: { kind: 'context_permission', permission: MODULE_ACCESS_PERMISSION },
      entrypointKey: 'core.identity.read-principal-binding',
      moduleKey: CORE_IDENTITY_MODULE_KEY,
      role: 'api',
    }),
    evidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: 'core.identity.read-principal-binding.access.v1',
    },
    inputSchema: ReadPrincipalBindingPayloadSchema,
    legalEntityScope: 'forbidden',
    owningModuleKey: CORE_IDENTITY_MODULE_KEY,
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

const BindingSubjectLookupInputSchema = Schema.Struct({
  authBindingId: AuthBindingIdSchema,
  authenticationNamespaceId: AuthenticationNamespaceIdSchema,
});

type BindingSubjectReadServices = Readonly<{
  readonly lookup: (input: {
    readonly authBindingId: Schema.Schema.Type<typeof AuthBindingIdSchema>;
    readonly authenticationNamespaceId: Schema.Schema.Type<typeof AuthenticationNamespaceIdSchema>;
    readonly tenantId: string;
  }) => Effect.Effect<ExternalAuthenticationSubject, ExternalIdentityFailure>;
}>;

type ResolveExternalSubjectReadResult = Schema.Schema.Type<typeof ResolveExternalSubjectResultSchema>;
interface ResolveExternalSubjectReadInput {
  readonly admission: ExternalIdentityAdmissionContext;
  readonly subject: ExternalAuthenticationSubject;
  readonly tenantId: string;
}
type ResolveExternalSubjectReadServices = Readonly<{
  readonly resolve: (
    input: ResolveExternalSubjectReadInput,
  ) => Effect.Effect<ResolveExternalSubjectReadResult, ExternalIdentityFailure>;
}>;

export const bindingSubjectRead = defineRead<
  typeof BindingSubjectLookupInputSchema,
  typeof ExternalAuthenticationSubjectSchema,
  'core.identity',
  BindingSubjectReadServices,
  ExternalIdentityError,
  never,
  typeof ExternalIdentityError
>(
  {
    accessKind: 'detail',
    domainErrorSchema: ExternalIdentityError,
    entrypoint: defineSystemModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'context_permission', permission: MODULE_ACCESS_PERMISSION },
      entrypointKey: 'core.identity.read-binding-subject',
      moduleKey: CORE_IDENTITY_MODULE_KEY,
      role: 'api',
    }),
    evidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: 'core.identity.read-binding-subject.access.v1',
    },
    inputSchema: BindingSubjectLookupInputSchema,
    legalEntityScope: 'forbidden',
    owningModuleKey: CORE_IDENTITY_MODULE_KEY,
    permissionTarget: 'tenant',
    policies: [],
    readKey: 'core.identity.read-binding-subject',
    resultSchema: ExternalAuthenticationSubjectSchema,
    schemaVersion: '1',
  },
  (input, context) =>
    context.services
      .lookup({
        ...input,
        tenantId: context.scope.tenantId,
      })
      .pipe(
        Effect.mapError((failure) => new ExternalIdentityError({ code: failure.code })),
        Effect.map((result) => ({ evidence: { resultCount: 1 }, result })),
      ),
  (transaction) =>
    Effect.succeed({
      lookup: (input: {
        readonly authBindingId: Schema.Schema.Type<typeof AuthBindingIdSchema>;
        readonly authenticationNamespaceId: Schema.Schema.Type<typeof AuthenticationNamespaceIdSchema>;
        readonly tenantId: string;
      }) => externalIdentitySubjectForBinding(transaction, input),
    }),
  () => ({ kind: 'tenant', permission: 'access' }),
);

export const resolveExternalSubjectRead = defineRead<
  typeof ExternalAuthenticationSubjectSchema,
  typeof ResolveExternalSubjectResultSchema,
  'core.identity',
  ResolveExternalSubjectReadServices,
  ExternalIdentityError,
  ExternalIdentityAdmission,
  typeof ExternalIdentityError
>(
  {
    accessKind: 'detail',
    domainErrorSchema: ExternalIdentityError,
    entrypoint: defineSystemModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'context_permission', permission: MODULE_ACCESS_PERMISSION },
      entrypointKey: 'core.identity.resolve-external-subject',
      moduleKey: CORE_IDENTITY_MODULE_KEY,
      role: 'api',
    }),
    evidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: 'core.identity.resolve-external-subject.access.v1',
    },
    inputSchema: ExternalAuthenticationSubjectSchema,
    legalEntityScope: 'forbidden',
    owningModuleKey: CORE_IDENTITY_MODULE_KEY,
    permissionTarget: 'tenant',
    policies: [],
    readKey: 'core.identity.resolve-external-subject',
    resultSchema: ResolveExternalSubjectResultSchema,
    schemaVersion: '1',
  },
  (subject, context) =>
    Effect.serviceOption(ExternalIdentityAdmission).pipe(
      Effect.flatMap((admission) =>
        Option.isNone(admission)
          ? Effect.fail(new ExternalIdentityError({ code: 'identity_unavailable' }))
          : context.services
              .resolve({
                admission: admission.value,
                subject,
                tenantId: context.scope.tenantId,
              })
              .pipe(Effect.mapError((failure) => new ExternalIdentityError({ code: failure.code }))),
      ),
      Effect.map((result) => ({ evidence: { resultCount: 1 }, result })),
    ),
  (transaction) => Effect.succeed({ resolve: resolveExternalSubjectFromTransaction(transaction) }),
  () => ({ kind: 'tenant', permission: 'access' }),
);
