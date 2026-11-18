/**
 * Core's own operations, referenced exactly like a vertical's: a module calls them through the same
 * `call`, covered by a requirement in its own manifest whose `provider.moduleId` is the Core module.
 * Core runs them in-process with the execution's own principal, under each operation's own access
 * decision and field groups. Adding a Core operation here is the only change a new Core target needs.
 */
import { Schema } from 'effect';

import { ActionInvocationIdSchema, PrincipalIdSchema } from '../auth/external-identity-contracts.ts';
import { managedPrincipalsRead } from '../auth/principal-administration-reads.ts';
import { AccessKeySyntaxSchema } from '../authorization/access-key-syntax.ts';
import { legalEntityDetailRead } from '../generated-reads/legal-entity-detail.ts';
import type { CallSchema, OperationProvider, OperationRef } from './index.ts';

const coreOperation = <RequestSchema extends CallSchema, ResponseSchema extends CallSchema>(input: {
  readonly provider: OperationProvider;
  readonly request: RequestSchema;
  readonly response: ResponseSchema;
}): OperationRef<RequestSchema, ResponseSchema> =>
  Object.freeze({
    _tag: 'OperationRef' as const,
    kind: 'read' as const,
    provider: Object.freeze({ ...input.provider }),
    request: input.request,
    response: input.response,
    // Value-only import of the index would be a load cycle (the index re-exports this file).
    route: Object.freeze({ _tag: 'Core' as const }),
  });

const ActionKeySchema = Schema.NonEmptyString.check(Schema.isMaxLength(300)).pipe(Schema.brand('ActionKey'));

/**
 * The commit state of one Action invocation of the calling module. Core binds the tenant and principal
 * of the execution, and requires `actionKey` to be an Action the calling module owns, so a module learns
 * only about its own invocations. `OPEN` is admitted and not settled, `ABSENT` is no such invocation for
 * this caller and key.
 */
export const ActionCommitStateRequestSchema = Schema.Struct({
  actionKey: ActionKeySchema,
  invocationId: ActionInvocationIdSchema,
});
export const ActionCommitStateResponseSchema = Schema.Struct({
  actionKey: ActionKeySchema,
  invocationId: ActionInvocationIdSchema,
  state: Schema.Literals(['ABSENT', 'COMMITTED', 'OPEN']),
});

/**
 * Which of the given principals may be assigned work under `capabilityKey`, an access key the calling
 * module owns, and which of them have departed. Identifiers only: eligibility to be assigned is not
 * permission to list people, so names come from `managedPrincipals` under its own access decision.
 */
export const AssignablePrincipalsRequestSchema = Schema.Struct({
  candidatePrincipalIds: Schema.Array(PrincipalIdSchema).check(Schema.isMaxLength(500)),
  capabilityKey: AccessKeySyntaxSchema.pipe(Schema.brand('AssignableCapabilityKey')),
});
export const AssignablePrincipalsResponseSchema = Schema.Struct({
  departedPrincipalIds: Schema.Array(PrincipalIdSchema),
  eligiblePrincipalIds: Schema.Array(PrincipalIdSchema),
});

export const coreOperations = Object.freeze({
  actionCommitState: coreOperation({
    provider: { entrypointKey: 'core.modules.api.action-commit-state', moduleId: 'core.modules', schemaVersion: '1' },
    request: ActionCommitStateRequestSchema,
    response: ActionCommitStateResponseSchema,
  }),
  assignablePrincipals: coreOperation({
    provider: {
      entrypointKey: 'core.identity.api.assignable-principals',
      moduleId: 'core.identity',
      schemaVersion: '1',
    },
    request: AssignablePrincipalsRequestSchema,
    response: AssignablePrincipalsResponseSchema,
  }),
  legalEntityDetail: coreOperation({
    provider: {
      entrypointKey: legalEntityDetailRead.descriptor.entrypoint.entrypointKey,
      moduleId: legalEntityDetailRead.descriptor.owningModuleKey,
      schemaVersion: legalEntityDetailRead.descriptor.schemaVersion,
    },
    request: legalEntityDetailRead.descriptor.inputSchema,
    response: legalEntityDetailRead.descriptor.resultSchema,
  }),
  managedPrincipals: coreOperation({
    provider: {
      entrypointKey: managedPrincipalsRead.descriptor.entrypoint.entrypointKey,
      moduleId: managedPrincipalsRead.descriptor.owningModuleKey,
      schemaVersion: managedPrincipalsRead.descriptor.schemaVersion,
    },
    request: managedPrincipalsRead.descriptor.inputSchema,
    response: managedPrincipalsRead.descriptor.resultSchema,
  }),
});

export type CoreOperations = typeof coreOperations;
