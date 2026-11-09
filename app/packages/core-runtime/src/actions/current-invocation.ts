import { and, eq, isNull } from 'drizzle-orm';
import { Effect, Option } from 'effect';

import { readScopedActionInvocationId } from '../access/enforcement/workload-admission.ts';
import { actionInvocations } from '../db/schema.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import type { OperationalScope } from '../operations/context.ts';
import { OperationContextUnavailable } from '../operations/errors.ts';

export interface ScopedCurrentActionInvocationFact {
  readonly actionInvocationId: string;
  readonly actionKey: string;
  readonly idempotencyKey: Option.Option<string>;
  readonly legalEntityId: Option.Option<string>;
  readonly principalId: string;
  readonly tenantId: string;
}

const unavailable = (cause?: unknown) => {
  const failure = new OperationContextUnavailable({
    code: 'operation_context_unavailable',
    reason: 'The exact live Action invocation could not be established',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { value: cause });
  }
  return failure;
};

/**
 * Reads facts about the currently running Action from its exact live owner-factory context.
 * The caller cannot select an invocation. These facts confer no authorization or replay authority.
 */
export const readScopedCurrentActionInvocation = Effect.fn('Action.readScopedCurrentInvocation')(
  function* readScopedCurrentActionInvocation(transaction: ScopedTransactionExecutor, scope: OperationalScope) {
    const actionInvocationId = readScopedActionInvocationId(transaction, scope);
    if (actionInvocationId === undefined) {
      return yield* unavailable();
    }
    const rows = yield* transaction
      .select({
        actionInvocationId: actionInvocations.actionInvocationId,
        actionKey: actionInvocations.actionKey,
        idempotencyKey: actionInvocations.idempotencyKey,
        legalEntityId: actionInvocations.legalEntityId,
        principalId: actionInvocations.principalId,
        status: actionInvocations.status,
        tenantId: actionInvocations.tenantId,
      })
      .from(actionInvocations)
      .where(
        and(
          eq(actionInvocations.actionInvocationId, actionInvocationId),
          eq(actionInvocations.tenantId, scope.tenantId),
          eq(actionInvocations.principalId, scope.principalId),
          scope.legalEntityId === undefined
            ? isNull(actionInvocations.legalEntityId)
            : eq(actionInvocations.legalEntityId, scope.legalEntityId),
          eq(actionInvocations.status, 'running'),
        ),
      )
      .limit(2)
      .pipe(Effect.mapError(unavailable));
    const [row] = rows;
    if (
      readScopedActionInvocationId(transaction, scope) !== actionInvocationId ||
      rows.length !== 1 ||
      row === undefined ||
      row.actionInvocationId !== actionInvocationId ||
      row.tenantId !== scope.tenantId ||
      row.principalId !== scope.principalId ||
      row.legalEntityId !== (scope.legalEntityId ?? null) ||
      row.status !== 'running'
    ) {
      return yield* unavailable();
    }
    return Object.freeze({
      actionInvocationId: row.actionInvocationId,
      actionKey: row.actionKey,
      idempotencyKey: Object.freeze(Option.fromNullishOr(row.idempotencyKey)),
      legalEntityId: Object.freeze(Option.fromNullishOr(row.legalEntityId)),
      principalId: row.principalId,
      tenantId: row.tenantId,
    }) satisfies ScopedCurrentActionInvocationFact;
  },
);
