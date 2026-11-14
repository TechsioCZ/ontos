import { and, eq } from 'drizzle-orm';
import { Effect, Option, Schema } from 'effect';

import { decodedStringBrand } from '../../actions/string-schemas.ts';
import { actionInvocations } from '../../db/schema.ts';
import type { CoreTransaction } from '../../db/types.ts';
import type { ScopedTransactionExecutor } from '../../db/scoped-transaction.ts';
import { accessDecisionUnavailable } from '../decision/errors.ts';

const ActionKeySchema = decodedStringBrand(Schema.NonEmptyString, 'ActionKey');
const IdempotencyKeySchema = decodedStringBrand(Schema.NonEmptyString, 'ActionIdempotencyKey');
const PrincipalIdSchema = decodedStringBrand(Schema.String.check(Schema.isUUID()), 'PrincipalId');
const OriginalActionInvocationQuerySchema = Schema.Struct({
  actionKey: ActionKeySchema,
  authContextRef: Schema.NonEmptyString,
  idempotencyKey: IdempotencyKeySchema,
  originalPrincipalId: PrincipalIdSchema,
  requestHash: Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/u)),
});
export type OriginalActionInvocationQuery = typeof OriginalActionInvocationQuerySchema.Type;

/** Historical facts only, inside the caller's installed tenant scope. This neither executes nor authorizes an Action. */
export const readOriginalActionInvocationFacts = Effect.fn('OriginalActionInvocation.readFacts')(
  function* readOriginalActionInvocationFacts(
    transaction: Pick<CoreTransaction, 'select'>,
    tenantId: string,
    input: OriginalActionInvocationQuery,
  ) {
    const query = yield* Schema.decodeUnknownEffect(OriginalActionInvocationQuerySchema)(input).pipe(
      Effect.mapError((cause) => accessDecisionUnavailable('The exact original Action identity is invalid', cause)),
    );
    const rows = yield* transaction
      .select({ actionInvocationId: actionInvocations.actionInvocationId, status: actionInvocations.status })
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
    return Option.fromUndefinedOr(rows[0]);
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
