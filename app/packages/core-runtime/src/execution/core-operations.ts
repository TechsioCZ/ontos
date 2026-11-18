/**
 * Core's own operations that module code may `call`, and the two Core reads that exist for it.
 *
 * Adding a Core operation touches Core in exactly two places and no Shell file:
 *
 * 1. its registration here, in `coreOperationRegistrations` (the in-process route registry of
 *    `execution/core-route.ts` and the genuine Core read list of `modules/module-operation-execution.ts`
 *    are both derived from it), and
 * 2. its reference in `sdk/core-operations.ts` (`coreOperations`);
 *
 * then the committed `topology/authorization-catalog.json` is regenerated
 * (`node ./scripts/authorization-catalog-artifact.mts` from `app/`).
 */
import { and, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { Effect, Schema } from 'effect';

import { managedPrincipalsRead } from '../auth/principal-administration-reads.ts';
import { readVerifiedGatewayRecovery } from '../auth/system-principal-context-provenance.ts';
import { accessMemberships, accessScopes, actionInvocations, principals } from '../db/schema.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import { legalEntityDetailRead } from '../generated-reads/legal-entity-detail.ts';
import { defineSystemModuleEntrypoint } from '../modules/module-entrypoint.ts';
import type { OperationalScope } from '../operations/context.ts';
import { defineRead } from '../reads/definition.ts';
import type { AnyReadRegistration } from '../reads/definition.ts';
import { ReadHandlerUnavailable } from '../reads/errors.ts';
import {
  ActionCommitStateRequestSchema,
  ActionCommitStateResponseSchema,
  AssignablePrincipalsRequestSchema,
  AssignablePrincipalsResponseSchema,
  coreOperations,
} from '../sdk/core-operations.ts';
import type { AnyReadOperationRef } from '../sdk/index.ts';

const databaseReadTimeout = '30 seconds';

const unavailable = (reason: string, cause?: unknown): ReadHandlerUnavailable => {
  const failure = new ReadHandlerUnavailable({ code: 'read_handler_unavailable', reason });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

/* ------------------------------------------------------------------------------------------------ */
/* core.modules.api.action-commit-state                                                             */
/* ------------------------------------------------------------------------------------------------ */

type ActionCommitStateRequest = typeof ActionCommitStateRequestSchema.Type;
type ActionCommitState = (typeof ActionCommitStateResponseSchema.Type)['state'];

interface ActionCommitStateServices {
  readonly resolve: (request: ActionCommitStateRequest) => Effect.Effect<ActionCommitState, ReadHandlerUnavailable>;
}

const commitStateUnavailable = (cause?: unknown) =>
  unavailable('The Action commit state is temporarily unavailable', cause);

/**
 * The commit state of an invocation as the Action runtime decides it (`resolveActionCommit`): a
 * succeeded invocation is committed; an admitted one that has not completed is open; no such
 * invocation for this tenant, principal and Action key is absent. A terminal state without a commit
 * cannot be told apart from an outage by the caller's own recovery, so it is unavailable, as there.
 */
export const classifyActionCommitState = (
  rows: readonly { readonly completedAt: Date | null; readonly status: string }[],
): Effect.Effect<ActionCommitState, ReadHandlerUnavailable> => {
  const [row] = rows;
  if (row === undefined) {
    return Effect.succeed('ABSENT');
  }
  if (rows.length !== 1) {
    return Effect.fail(commitStateUnavailable());
  }
  if (row.status === 'succeeded') {
    return Effect.succeed('COMMITTED');
  }
  const admitted = row.status === 'received' || row.status === 'running' || row.status === 'indeterminate';
  return admitted && row.completedAt === null ? Effect.succeed('OPEN') : Effect.fail(commitStateUnavailable());
};

const actionCommitStateServices = (
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
): ActionCommitStateServices => ({
  resolve: (request) => {
    // A recovery principal learns only about the exact original invocation its recovery names.
    const recovery = readVerifiedGatewayRecovery(scope);
    if (
      recovery !== undefined &&
      (recovery.originalActionInvocationId !== request.invocationId || recovery.originalActionKey !== request.actionKey)
    ) {
      return Effect.succeed('ABSENT');
    }
    return transaction
      .select({ completedAt: actionInvocations.completedAt, status: actionInvocations.status })
      .from(actionInvocations)
      .where(
        and(
          eq(actionInvocations.tenantId, scope.tenantId),
          eq(actionInvocations.actionInvocationId, request.invocationId),
          eq(actionInvocations.actionKey, request.actionKey),
          eq(actionInvocations.principalId, recovery?.originalPrincipalId ?? scope.principalId),
        ),
      )
      .limit(2)
      .pipe(
        Effect.mapError(commitStateUnavailable),
        Effect.timeoutOrElse({ duration: databaseReadTimeout, orElse: () => Effect.fail(commitStateUnavailable()) }),
        Effect.flatMap(classifyActionCommitState),
      );
  },
});

/**
 * The commit state of one Action invocation of the calling module, bound to the tenant and principal
 * of the execution. Core's route refuses an `actionKey` the calling module does not own before this
 * read runs.
 */
export const actionCommitStateRead = defineRead<
  typeof ActionCommitStateRequestSchema,
  typeof ActionCommitStateResponseSchema,
  'core.modules',
  ActionCommitStateServices,
  ReadHandlerUnavailable,
  never
>(
  {
    accessDeclaration: {
      key: 'core.modules.action-commit-state.read',
      kind: 'read',
      modes: ['run'],
      placement: { group: 'modules', level: 'basic' },
      risk: 'routine',
      selectors: [],
    },
    accessKind: 'detail',
    entrypoint: defineSystemModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'protected' },
      entrypointKey: 'core.modules.api.action-commit-state',
      moduleKey: 'core.modules',
      role: 'api',
    }),
    evidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: 'core.modules.api.action-commit-state.access.v1',
    },
    inputSchema: ActionCommitStateRequestSchema,
    legalEntityScope: 'optional',
    owningModuleKey: 'core.modules',
    policies: [],
    readKey: 'core.modules.api.action-commit-state',
    resultSchema: ActionCommitStateResponseSchema,
    schemaVersion: '1',
  },
  {
    load: Effect.fn('ActionCommitState.read')(function* actionCommitStateHandler(input, context) {
      const state = yield* context.services.resolve(input);
      return {
        evidence: { resultCount: 1 },
        result: { actionKey: input.actionKey, invocationId: input.invocationId, state },
      };
    }),
  },
  (transaction, scope) => Effect.succeed(actionCommitStateServices(transaction, scope)),
);

/* ------------------------------------------------------------------------------------------------ */
/* core.identity.api.assignable-principals                                                          */
/* ------------------------------------------------------------------------------------------------ */

type AssignablePrincipalsRequest = typeof AssignablePrincipalsRequestSchema.Type;
type AssignablePrincipalsResponse = typeof AssignablePrincipalsResponseSchema.Type;

export interface AssignableCandidateRow {
  readonly displayName: string;
  readonly kind: string;
  readonly member: boolean;
  readonly principalId: string;
  readonly status: string;
}

interface AssignablePrincipalsServices {
  readonly load: (
    principalIds: readonly string[],
  ) => Effect.Effect<readonly AssignableCandidateRow[], ReadHandlerUnavailable>;
}

const assignableUnavailable = (cause?: unknown) =>
  unavailable('Assignable principals are temporarily unavailable', cause);

/**
 * People and agents of this tenant only (a service or integration identity is never an assignee). An
 * active principal with a live membership of the execution's access scope is eligible; one that is no
 * longer active or no longer a member has departed; an id that names no such principal is neither. The
 * order of the request is kept and repeated ids answer once.
 */
export const classifyAssignablePrincipals = (
  request: Pick<AssignablePrincipalsRequest, 'candidatePrincipalIds'>,
  rows: readonly AssignableCandidateRow[],
): Effect.Effect<AssignablePrincipalsResponse, ReadHandlerUnavailable> => {
  const byId = new Map(rows.map((row) => [row.principalId, row]));
  const eligible: { displayName: string; principalId: string }[] = [];
  const departed: string[] = [];
  for (const principalId of new Set(request.candidatePrincipalIds)) {
    const row = byId.get(principalId);
    if (row !== undefined && (row.kind === 'human' || row.kind === 'agent')) {
      if (row.status === 'active' && row.member) {
        eligible.push({ displayName: row.displayName, principalId });
      } else {
        departed.push(principalId);
      }
    }
  }
  return Schema.decodeUnknownEffect(AssignablePrincipalsResponseSchema)({
    departedPrincipalIds: departed,
    eligible,
  }).pipe(Effect.mapError(assignableUnavailable));
};

const assignablePrincipalsServices = (
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
): AssignablePrincipalsServices => ({
  load: (principalIds) => {
    if (principalIds.length === 0) {
      return Effect.succeed([]);
    }
    const scopeOf =
      scope.legalEntityId === undefined
        ? eq(accessScopes.tenantContextId, scope.tenantId)
        : eq(accessScopes.legalEntityId, scope.legalEntityId);
    const memberships = transaction
      .select({ principalId: accessMemberships.principalId })
      .from(accessMemberships)
      .innerJoin(
        accessScopes,
        and(eq(accessScopes.tenantId, accessMemberships.tenantId), eq(accessScopes.scopeId, accessMemberships.scopeId)),
      )
      .where(
        and(
          eq(accessMemberships.tenantId, scope.tenantId),
          scopeOf,
          inArray(accessMemberships.principalId, [...principalIds]),
          eq(accessMemberships.status, 'active'),
          lte(accessMemberships.validFrom, sql`statement_timestamp()`),
          or(isNull(accessMemberships.validUntil), gt(accessMemberships.validUntil, sql`statement_timestamp()`)),
        ),
      );
    const people = transaction
      .select({
        displayName: principals.displayName,
        kind: principals.kind,
        principalId: principals.principalId,
        status: principals.status,
      })
      .from(principals)
      .where(and(eq(principals.tenantId, scope.tenantId), inArray(principals.principalId, [...principalIds])));
    return Effect.all({ members: memberships, people }, { concurrency: 1 }).pipe(
      Effect.mapError(assignableUnavailable),
      Effect.timeoutOrElse({ duration: databaseReadTimeout, orElse: () => Effect.fail(assignableUnavailable()) }),
      Effect.map(({ members, people: rows }) => {
        const memberIds = new Set(members.flatMap(({ principalId }) => (principalId === null ? [] : [principalId])));
        return rows.map((row) => ({ ...row, member: memberIds.has(row.principalId) }));
      }),
    );
  },
});

/**
 * Which of the given principals may be assigned work in the execution's access scope, and which of
 * them have departed. The names are in their own field group (`ASSIGNABLE_PRINCIPAL_NAMES_FIELD_GROUP`
 * of `sdk/core-operations.ts`), so being able to assign is never permission to see people. Core's route
 * refuses a `capabilityKey` the calling module does not own before this read runs.
 */
export const assignablePrincipalsRead = defineRead<
  typeof AssignablePrincipalsRequestSchema,
  typeof AssignablePrincipalsResponseSchema,
  'core.identity',
  AssignablePrincipalsServices,
  ReadHandlerUnavailable,
  never
>(
  {
    accessDeclaration: {
      key: 'core.identity.assignable-principal.read',
      kind: 'read',
      modes: ['run'],
      placement: { group: 'identity', level: 'basic' },
      risk: 'routine',
      selectors: [],
    },
    accessFieldGroups: [
      {
        fieldClass: 'personal_data',
        fields: ['eligible.displayName'],
        key: 'core.identity.assignable-principals.names',
        kind: 'field_read',
        modes: ['run'],
        placement: { group: 'identity', level: 'extended' },
        risk: 'sensitive',
        selectors: [],
      },
    ],
    accessKind: 'detail',
    entrypoint: defineSystemModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'protected' },
      entrypointKey: 'core.identity.api.assignable-principals',
      moduleKey: 'core.identity',
      role: 'api',
    }),
    evidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: 'core.identity.api.assignable-principals.access.v1',
    },
    inputSchema: AssignablePrincipalsRequestSchema,
    legalEntityScope: 'optional',
    owningModuleKey: 'core.identity',
    policies: [],
    readKey: 'core.identity.api.assignable-principals',
    resultSchema: AssignablePrincipalsResponseSchema,
    schemaVersion: '1',
  },
  {
    load: Effect.fn('AssignablePrincipals.read')(function* assignablePrincipalsHandler(input, context) {
      const rows = yield* context.services.load([...new Set(input.candidatePrincipalIds)]);
      const result = yield* classifyAssignablePrincipals(input, rows);
      return { evidence: { resultCount: result.eligible.length }, result };
    }),
  },
  (transaction, scope) => Effect.succeed(assignablePrincipalsServices(transaction, scope)),
);

/* ------------------------------------------------------------------------------------------------ */
/* The registry                                                                                     */
/* ------------------------------------------------------------------------------------------------ */

/** One Core operation a module may call: its reference, its read, and the request field the caller must own. */
export interface CoreOperationRegistration {
  /**
   * The request field holding a key (an Action key, an access key) that must belong to the calling
   * module, when the operation answers only about the caller's own things.
   */
  readonly callerOwnedField?: 'actionKey' | 'capabilityKey';
  readonly operation: AnyReadOperationRef;
  readonly registration: AnyReadRegistration;
}

export const coreOperationRegistrations: readonly CoreOperationRegistration[] = Object.freeze([
  Object.freeze({
    callerOwnedField: 'actionKey' as const,
    operation: coreOperations.actionCommitState,
    registration: actionCommitStateRead,
  }),
  Object.freeze({
    callerOwnedField: 'capabilityKey' as const,
    operation: coreOperations.assignablePrincipals,
    registration: assignablePrincipalsRead,
  }),
  Object.freeze({ operation: coreOperations.legalEntityDetail, registration: legalEntityDetailRead }),
  Object.freeze({ operation: coreOperations.managedPrincipals, registration: managedPrincipalsRead }),
]);
