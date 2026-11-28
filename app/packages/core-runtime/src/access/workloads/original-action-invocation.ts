import { and, eq, sql } from 'drizzle-orm';
import { Effect, Option, Schema } from 'effect';

import { decodedStringBrand } from '../../actions/string-schemas.ts';
import { actionInvocations } from '../../db/schema.ts';
import type { CoreTransaction } from '../../db/types.ts';
import type { ScopedTransactionExecutor } from '../../db/scoped-transaction.ts';
import { accessDecisionUnavailable } from '../decision/errors.ts';

const ActionKeySchema = decodedStringBrand(Schema.NonEmptyString, 'ActionKey');
const IdempotencyKeySchema = decodedStringBrand(Schema.NonEmptyString, 'ActionIdempotencyKey');
const invocationIdentity = {
  actionInvocationId: actionInvocations.actionInvocationId,
  status: actionInvocations.status,
};
const PrincipalIdSchema = decodedStringBrand(Schema.String.check(Schema.isUUID()), 'PrincipalId');
const OriginalActionInvocationQuerySchema = Schema.Struct({
  actionKey: ActionKeySchema,
  authContextRef: Schema.NonEmptyString,
  idempotencyKey: IdempotencyKeySchema,
  originalPrincipalId: PrincipalIdSchema,
  requestHash: Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/u)),
});
export type OriginalActionInvocationQuery = typeof OriginalActionInvocationQuerySchema.Type;

interface OriginalActionFact {
  readonly actionInvocationId: string;
  readonly sourceEffectOutcome?: 'changed' | 'unchanged' | 'rejected';
  readonly status: (typeof actionInvocations.$inferSelect)['status'];
}

/** Historical facts only, inside the caller's installed tenant scope. This neither executes nor authorizes an Action. */
export const readOriginalActionInvocationFacts = Effect.fn('OriginalActionInvocation.readFacts')(
  function* readOriginalActionInvocationFacts(
    transaction: Pick<CoreTransaction, 'select'>,
    tenantId: string,
    input: OriginalActionInvocationQuery,
    deliveryAuthContextRef?: string,
  ) {
    const query = yield* Schema.decodeUnknownEffect(OriginalActionInvocationQuerySchema)(input).pipe(
      Effect.mapError((cause) => accessDecisionUnavailable('The exact original Action identity is invalid', cause)),
    );
    const rows = yield* transaction
      .select({
        ...invocationIdentity,
        // Never return the saved reply. Only the original, Core-attested delivery gets the owner's one-bit fact.
        sourceEffectOutcome:
          deliveryAuthContextRef === query.authContextRef
            ? sql<
                'changed' | 'unchanged' | 'rejected' | null
              >`case when ${actionInvocations.status} = 'succeeded' and ${actionInvocations.committedReplyJson}->>'kind' = 'rejection' then 'rejected' when ${actionInvocations.status} = 'succeeded'
            and ${actionInvocations.committedReplyJson}->>'kind' = 'result'
            and ${actionInvocations.committedReplyJson}#>>'{encoded,sourceEffectSettlement,key}' = ${actionInvocations.idempotencyKey}
            and jsonb_typeof(${actionInvocations.committedReplyJson}#>'{encoded,sourceEffectSettlement,changed}') = 'boolean'
            then case when (${actionInvocations.committedReplyJson}#>>'{encoded,sourceEffectSettlement,changed}')::boolean then 'changed' else 'unchanged' end end`
            : sql<null>`NULL`,
      })
      .from(actionInvocations)
      .where(
        and(
          eq(actionInvocations.tenantId, tenantId),
          eq(actionInvocations.principalId, query.originalPrincipalId),
          eq(actionInvocations.actionKey, query.actionKey),
          eq(actionInvocations.idempotencyKey, query.idempotencyKey),
          eq(actionInvocations.requestHash, query.requestHash),
          eq(actionInvocations.authContextRef, query.authContextRef),
        ),
      )
      .limit(2)
      .pipe(
        Effect.mapError((cause) =>
          accessDecisionUnavailable('The exact original Action facts could not be read', cause),
        ),
      );
    if (rows.length > 1) {
      return yield* accessDecisionUnavailable('The exact original Action identity is ambiguous');
    }
    const [row] = rows;
    if (row === undefined) {
      return Option.none<OriginalActionFact>();
    }
    const identity = { actionInvocationId: row.actionInvocationId, status: row.status };
    const change = Option.fromNullishOr(row.sourceEffectOutcome);
    const fact: OriginalActionFact = Option.isSome(change)
      ? { ...identity, sourceEffectOutcome: change.value }
      : identity;
    return Option.some(fact);
  },
);

export type OriginalActionInvocationReader = (
  input: OriginalActionInvocationQuery,
) => ReturnType<typeof readOriginalActionInvocationFacts>;

/** The owner Action receives only the factual reader on its existing scoped transaction. */
export const readScopedOriginalActionInvocation = (
  transaction: ScopedTransactionExecutor,
  input: OriginalActionInvocationQuery,
) => readOriginalActionInvocationFacts(transaction, transaction.scope.tenantId, input);
