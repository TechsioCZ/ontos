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
import { GrantedProvisioningNamespaces, authorizeReadNamespace } from './namespace-authority.ts';
import { externalIdentityRepositoryFromTransaction, externalIdentitySubjectForBinding } from './repository.ts';
import { ExternalIdentityAdmission, resolveExternalSubjectFromTransaction } from './resolve.ts';
import type { ExternalAuthenticationSubject } from '../external-identity-contracts.ts';
import type { ExternalIdentityFailure } from './errors.ts';
import type { ExternalIdentityAdmissionContext, ExternalIdentityRepositoryService } from './repository.ts';
import { AuthenticationNamespaceRegistry } from './verifier.ts';
import { defineSystemModuleEntrypoint } from '../../modules/module-entrypoint.ts';
import { defineRead } from '../../reads/definition.ts';
import type { ReadHandlerContext } from '../../reads/context.ts';

const CORE_IDENTITY_MODULE_KEY = 'core.identity';
const IDENTITY_PROVIDER_WORKLOAD = 'core.identity-provider';

export type ReadPrincipalBindingPayload = Schema.Schema.Type<typeof ReadPrincipalBindingPayloadSchema>;

type ReadPrincipalBindingServices = Readonly<{
  readonly read: ExternalIdentityRepositoryService['read'];
}>;

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
    accessDeclaration: {
      key: 'core.identity.principal-binding.read',
      kind: 'admin',
      modes: ['run'],
      placement: { group: 'identity', level: 'manage' },
      risk: 'sensitive',
      selectors: [],
    },
    // The external identity workload resolves the binding of the subject it is admitting; the
    // declaration above is the human administrative path and the two never mix (O67-Q4, O72).
    // The owner still qualifies the namespace of the machine actor (classification: exact namespace
    // provision OR tenant administration).
    accessKind: 'detail',
    accessWorkload: {
      reason:
        'The external identity workload resolves the binding of the subject it is admitting; a human capability would let any holder look up any binding (O29, O59, O72).',
      workloads: [IDENTITY_PROVIDER_WORKLOAD],
    },
    domainErrorSchema: ExternalIdentityError,
    entrypoint: defineSystemModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'protected' },
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
    policies: [],
    readKey: 'core.identity.read-principal-binding',
    resultSchema: ReadPrincipalBindingResultSchema,
    schemaVersion: '1',
  },
  handle,
  Effect.fn('ReadPrincipalBinding.services')(function* makeServices(transaction, scope) {
    const registry = yield* Effect.serviceOption(AuthenticationNamespaceRegistry);
    const granted = yield* Effect.serviceOption(GrantedProvisioningNamespaces);
    const dependencies = {
      authorizeReadNamespace: (authenticationNamespaceId: string) =>
        authorizeReadNamespace({ authenticationNamespaceId, granted, scope }),
    };
    if (Option.isSome(registry)) {
      Object.assign(dependencies, { registry: registry.value });
    }
    const repository = externalIdentityRepositoryFromTransaction(transaction, dependencies);
    return { read: repository.read };
  }),
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
    accessDeclaration: {
      key: 'core.identity.binding-subject.read',
      kind: 'read',
      modes: ['run'],
      placement: { group: 'external-identity', level: 'extended' },
      risk: 'sensitive',
      selectors: [],
    },
    // The external identity workload reads the subject of the binding it is admitting; the
    // declaration above is the human administrative path and the two never mix (O67-Q4, O72).
    accessKind: 'detail',
    accessWorkload: {
      reason:
        'The external identity workload reads the subject of the binding it is admitting; a human capability would let any holder look up any subject (O29, O59, O72).',
      workloads: [IDENTITY_PROVIDER_WORKLOAD],
    },
    domainErrorSchema: ExternalIdentityError,
    entrypoint: defineSystemModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'protected' },
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
    accessDeclaration: {
      key: 'core.identity.external-subject.resolve',
      kind: 'read',
      modes: ['run'],
      placement: { group: 'external-identity', level: 'extended' },
      risk: 'sensitive',
      selectors: [],
    },
    // The external identity workload resolves the subject it is admitting; the declaration above is
    // the human administrative path and the two never mix (O67-Q4, O72).
    accessKind: 'detail',
    accessWorkload: {
      reason:
        'The external identity workload resolves the subject it is admitting; a human capability would let any holder resolve any subject (O29, O59, O72).',
      workloads: [IDENTITY_PROVIDER_WORKLOAD],
    },
    domainErrorSchema: ExternalIdentityError,
    entrypoint: defineSystemModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'protected' },
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
);
