/**
 * `@app/core-runtime/sdk/core`: Core's own operations, referenced exactly like a vertical's. A module
 * calls them through the same `call`, covered by a requirement in its own manifest whose
 * `provider.moduleId` is the Core module (such a requirement declares no `callers`). Core runs them
 * in-process with the execution's own principal, under each operation's own access decision and field
 * groups.
 *
 * A separate subpath because these references are built from Core read registrations (database
 * code): `@app/core-runtime/sdk` stays free of database and registration imports, so contract packages
 * can import `moduleOperation` from it without pulling Core server code.
 *
 * Adding a Core operation touches Core in exactly two places, and no Shell file: its registration in
 * `execution/core-operations.ts` (`coreOperationRegistrations`, from which both the in-process route
 * registry and the genuine Core read list in `modules/module-operation-execution.ts` are derived), and
 * its reference here; then the committed `topology/authorization-catalog.json` is regenerated.
 */
import { Schema } from 'effect';

import { ActionInvocationIdSchema, PrincipalIdSchema } from '../auth/external-identity-contracts.ts';
import { managedPrincipalsRead } from '../auth/principal-administration-reads.ts';
import { AccessKeySyntaxSchema } from '../authorization/access-key-syntax.ts';
import { legalEntityDetailRead } from '../generated-reads/legal-entity-detail.ts';
import { CoreOperationRouteSchema } from './index.ts';
import type { CallSchema, OperationProvider, OperationRef } from './index.ts';

const coreOperation = <RequestSchema extends CallSchema, ResponseSchema extends CallSchema>(input: {
  readonly provider: OperationProvider;
  readonly request: RequestSchema;
  readonly response: ResponseSchema;
}): OperationRef<RequestSchema, ResponseSchema> =>
  Object.freeze({
    kind: 'read' as const,
    provider: Object.freeze({ ...input.provider }),
    request: input.request,
    response: input.response,
    route: CoreOperationRouteSchema.make({}),
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
 * The personal-data field group of the assignable principals read. Core removes `displayName` from the
 * answer for a caller its gate does not allow to see this group; eligibility to be assigned is not
 * permission to see people.
 */
export const ASSIGNABLE_PRINCIPAL_NAMES_FIELD_GROUP = 'core.identity.assignable-principals.names';

/**
 * Which of the given principals may be assigned work under `capabilityKey`, an access key the calling
 * module owns, and which of them have departed. Every eligible principal carries its id; its
 * `displayName` is in the field group `ASSIGNABLE_PRINCIPAL_NAMES_FIELD_GROUP` and is absent when the
 * caller may not see it.
 */
export const AssignablePrincipalsRequestSchema = Schema.Struct({
  candidatePrincipalIds: Schema.Array(PrincipalIdSchema).check(Schema.isMaxLength(500)),
  capabilityKey: AccessKeySyntaxSchema.pipe(Schema.brand('AssignableCapabilityKey')),
});
export const AssignablePrincipalsResponseSchema = Schema.Struct({
  departedPrincipalIds: Schema.Array(PrincipalIdSchema),
  eligible: Schema.Array(
    Schema.Struct({
      displayName: Schema.optionalKey(Schema.String),
      principalId: PrincipalIdSchema,
    }),
  ),
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
