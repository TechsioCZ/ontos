import { sql } from 'drizzle-orm';
import type { SQLWrapper } from 'drizzle-orm';
import { Effect, Schema } from 'effect';
import {
  IcoCorrelationCoverageSchema,
  IcoCorrelationWitnessesSchema,
  IcoCorrelationWitnessSchema,
} from '../../shared/apis/legacy-ico-inventory.ts';
import type { IcoCorrelationWitness } from '../../shared/apis/legacy-ico-inventory.ts';
import { PartyPersistenceUnavailable } from '../../shared/domain/identity-contracts.ts';
import type { PartyTransaction } from '../db/types.ts';

const unavailable = (cause: unknown) =>
  Object.assign(
    new PartyPersistenceUnavailable({
      code: 'party_persistence_unavailable',
      reason: 'Current Party correlation proof is unavailable',
    }),
    { cause },
  );
const encodeWitnesses = Schema.encodeEffect(Schema.fromJsonString(IcoCorrelationWitnessesSchema));

/** Select the opaque proof in the exact native Counterparty fact statement's snapshot. */
export const icoCorrelationWitnessSelection = (counterpartyId: SQLWrapper, includeWitness: true | undefined) =>
  includeWitness === true ? sql<unknown>`party.issue_ico_correlation_witness(${counterpartyId})` : sql<unknown>`null`;

export const decodeIcoCorrelationWitness = Schema.decodeUnknownEffect(
  Schema.OptionFromNullOr(IcoCorrelationWitnessSchema),
);

/** Only aggregate counts for the already-authorized assertion order cross this boundary. */
export const observeIcoCorrelationCoverage = Effect.fn('PartyIcoCorrelation.observe')(function* observe(
  transaction: Pick<PartyTransaction, 'select'>,
  assertionIds: readonly string[],
  witnesses: readonly IcoCorrelationWitness[] | undefined,
) {
  const encoded = witnesses === undefined ? null : yield* encodeWitnesses(witnesses).pipe(Effect.mapError(unavailable));
  const [row] = yield* transaction
    .select({
      coverage: sql<unknown>`party.observe_ico_correlation_coverage(${sql.param(assertionIds)}::uuid[],${encoded}::jsonb)`,
    })
    .from(sql`(values (1)) as party_ico_coverage_anchor(value)`)
    .pipe(Effect.mapError(unavailable));
  return yield* Schema.decodeUnknownEffect(Schema.OptionFromNullOr(IcoCorrelationCoverageSchema))(
    row?.coverage ?? null,
  ).pipe(Effect.mapError(unavailable));
});
