import type { PgClient } from '@effect/sql-pg';
import { Effect, Schema } from 'effect';

/**
 * Lossless additive preparation for the Party candidate snapshot constraint change.
 *
 * The structured-names migration adds `firstName`/`lastName`/`businessName` to
 * `party.duplicate_candidate_cases.candidate_snapshot` and replaces the old `names`-array CHECK.
 * Rows written by the previous snapshot shape carry `names` and omit the structured keys, so the new
 * CHECK rejects them. This preparation adds ONLY the absent structured keys as JSON null, keeping every
 * existing member byte-for-byte (names, provenance, validFrom, officialIdentifiers and the rest) and
 * never splitting `names` into fabricated facts. Existing structured values always win, and a second
 * preparation updates zero rows.
 *
 * `party.duplicate_candidate_cases` carries FORCE ROW LEVEL SECURITY, so this update only reaches rows
 * when DATABASE_ADMIN_URL connects as a superuser or BYPASSRLS role (the same requirement as
 * scripts/demo/migrate-domain-regroup.mts). Otherwise the update silently matches nothing and the
 * following constraint change fails closed.
 */
export const PartyStructuredNamesStateSchema = Schema.Literals(['absent', 'prepared', 'unchanged']);
export type PartyStructuredNamesState = typeof PartyStructuredNamesStateSchema.Type;

class PartyStructuredNamesMigrationError extends Schema.TaggedError<PartyStructuredNamesMigrationError>()(
  'PartyStructuredNamesMigrationError',
  { cause: Schema.Unknown, message: Schema.String },
) {}

// Fixed, data-free messages: no SQL text, parameters, credentials or row values escape.
const PROBE_FAILED = 'PostgreSQL candidate snapshot probe failed';
const PREPARATION_FAILED = 'PostgreSQL candidate snapshot preparation failed';

const databaseFailure = (message: string, cause: unknown): PartyStructuredNamesMigrationError =>
  new PartyStructuredNamesMigrationError({ cause, message });

export const PARTY_STRUCTURED_NAMES_PROBE_SQL = `select
        to_regclass('party.duplicate_candidate_cases') is not null as present`;

/**
 * Add only the absent structured keys, as JSON null, to recognizable legacy snapshots (those that still
 * carry a `names` array). Existing keys and every other member are preserved by construction, and the
 * `?&` guard leaves already-complete rows out of the write set.
 */
export const PARTY_STRUCTURED_NAMES_PREPARATION_SQL = `with prepared_rows as (
        update party.duplicate_candidate_cases
        set candidate_snapshot = candidate_snapshot || jsonb_build_object(
          'firstName', case when candidate_snapshot ? 'firstName' then candidate_snapshot -> 'firstName' else 'null'::jsonb end,
          'lastName', case when candidate_snapshot ? 'lastName' then candidate_snapshot -> 'lastName' else 'null'::jsonb end,
          'businessName', case when candidate_snapshot ? 'businessName' then candidate_snapshot -> 'businessName' else 'null'::jsonb end
        )
        where jsonb_typeof(candidate_snapshot) = 'object'
          and jsonb_typeof(candidate_snapshot -> 'names') = 'array'
          and not candidate_snapshot ?& array['firstName', 'lastName', 'businessName']
        returning 1
      )
      select count(*)::integer as prepared from prepared_rows`;

const query = <Row extends object>(client: PgClient.PgClient, text: string, operation: string) =>
  client.unsafe<Row>(text).pipe(Effect.mapError((cause) => databaseFailure(operation, cause)));

export const preparePartyStructuredNames = Effect.fn('preparePartyStructuredNames')(
  function* preparePartyStructuredNamesEffect(client: PgClient.PgClient) {
    return yield* client
      .withTransaction(
        Effect.gen(function* preparePartyStructuredNamesTransactionEffect() {
          const rows = yield* query<{ present: boolean }>(client, PARTY_STRUCTURED_NAMES_PROBE_SQL, PROBE_FAILED);
          if (rows[0]?.present !== true) {
            return 'absent' satisfies PartyStructuredNamesState;
          }
          const prepared = yield* query<{ prepared: number }>(
            client,
            PARTY_STRUCTURED_NAMES_PREPARATION_SQL,
            PREPARATION_FAILED,
          );
          return (prepared[0]?.prepared ?? 0) > 0
            ? ('prepared' satisfies PartyStructuredNamesState)
            : ('unchanged' satisfies PartyStructuredNamesState);
        }),
      )
      .pipe(
        Effect.catchTag('SqlError', (cause) =>
          Effect.fail(databaseFailure('PostgreSQL transaction control failed', cause)),
        ),
      );
  },
);
