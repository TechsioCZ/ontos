import { createHash } from 'node:crypto';
import { defineScopedRoutine } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { AssortmentPolicyPersistenceUnavailable } from '../../shared/domain/policy-errors.ts';

const CanonicalJsonSchema: Schema.Codec<Schema.Json> = Schema.suspend(() =>
  Schema.Union([
    Schema.Null,
    Schema.Boolean,
    Schema.Finite,
    Schema.String,
    Schema.Array(CanonicalJsonSchema),
    Schema.Record(Schema.String, CanonicalJsonSchema),
  ]),
);
const CanonicalJsonRecordSchema = Schema.Record(Schema.String, CanonicalJsonSchema);
const DecisionSetProofPayloadSchema = Schema.Struct({
  fenceToken: Schema.String,
  query: CanonicalJsonSchema,
  rows: Schema.Array(CanonicalJsonSchema),
});
type DecisionSetProofPayload = typeof DecisionSetProofPayloadSchema.Type;
const CanonicalJsonStringSchema = Schema.fromJsonString(CanonicalJsonSchema);

const lockDecisionSetFence = defineScopedRoutine({
  name: 'lock_decision_set_fence',
  ownerModuleKey: 'commerce.assortment',
  parameters: [{ source: 'tenantId', type: 'uuid' }],
  resultSchema: Schema.Struct({ generation: Schema.String }),
  routineKey: 'decision-set.lock-fence',
  schema: 'assortment',
});

const canonicalJson = (value: Schema.Json): Schema.Json => {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (Schema.is(CanonicalJsonRecordSchema)(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right, 'en'))
        .map(([key, child]) => [key, canonicalJson(child)]),
    );
  }
  return value;
};

const encodeCanonical = (value: Schema.Json) => Schema.encodeEffect(CanonicalJsonStringSchema)(canonicalJson(value));

/**
 * Bind an exact owner query, its complete JSON rows, and the locked tenant fence into one
 * resource identity. Rows are sorted as a set so SQL row order cannot alter proof identity.
 */
export const decisionSetProofResourceId = Effect.fn('DecisionSetProof.decisionSetProofResourceId')(
  function* decisionSetProofResourceId(input: {
    readonly fenceToken: DecisionSetProofPayload['fenceToken'];
    readonly query: Schema.Json;
    readonly rows: readonly Schema.Json[];
  }) {
    const encodedRows = yield* Effect.forEach(
      input.rows,
      (row) => encodeCanonical(row).pipe(Effect.map((encoded) => ({ encoded, row }))),
      { concurrency: 1 },
    );
    const orderedRows = encodedRows
      .toSorted((left, right) => left.encoded.localeCompare(right.encoded, 'en'))
      .map(({ row }) => row);
    const payload: DecisionSetProofPayload = { fenceToken: input.fenceToken, query: input.query, rows: orderedRows };
    const encodedPayload = yield* encodeCanonical(payload);
    const digest = createHash('sha256').update(encodedPayload, 'utf-8').digest('hex');
    return `v1-${digest}`;
  },
);

type DecisionSetFenceQueryFailure = InstanceType<typeof AssortmentPolicyPersistenceUnavailable>;
type DecisionSetFenceQuery = () => Effect.Effect<
  readonly Readonly<{ readonly generation: string }>[],
  DecisionSetFenceQueryFailure
>;

/** Validate the result of the owner-scoped fence query. */
export const readDecisionSetFenceTokenFromQuery = (readFence: DecisionSetFenceQuery) =>
  readFence().pipe(
    Effect.flatMap((rows) => {
      const generation = rows[0]?.generation;
      return generation === undefined
        ? Effect.fail(
            new AssortmentPolicyPersistenceUnavailable({
              code: 'assortment_policy_persistence_unavailable',
              reason: 'Assortment decision-set proof is temporarily unavailable',
            }),
          )
        : Effect.succeed(generation);
    }),
  );

/** Read and lock the owner fence under the Core-installed tenant scope. */
export const readDecisionSetFenceToken = (transaction: ScopedTransactionExecutor) =>
  readDecisionSetFenceTokenFromQuery(() =>
    transaction.invoke(lockDecisionSetFence, []).pipe(
      Effect.mapError((cause) => {
        const failure = new AssortmentPolicyPersistenceUnavailable({
          code: 'assortment_policy_persistence_unavailable',
          reason: 'Assortment decision-set proof is temporarily unavailable',
        });
        Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
        return failure;
      }),
    ),
  );
