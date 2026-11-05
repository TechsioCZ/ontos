import { Effect, Option } from 'effect';

import type { OperationalScope } from '../../operations/context.ts';
import type { AccessDecisionUnavailable } from '../decision/errors.ts';
import type { ListRowProjection } from '../decision/list-access.ts';
import type { ModuleKey, RecordKey } from '../ids.ts';

/**
 * The owner's projection of ONE record (R5a-7).
 *
 * A list decides its rows from the owner's own SQL projection (`ListRowProjection`). A record-scoped
 * decision must be decided from the same facts, or `list` can show a row that `decide(target)` refuses —
 * and in v2 nothing writes an `access_record` relation, so the graph can never be that authority. This
 * port is where the owner hands Core the projection of the single record a decision names; Core reads no
 * other source and hard-codes no relation.
 *
 * Two failure modes, deliberately different (O48):
 *  - the owner answers "no such projected record" (`Option.none`) → the selector reaches nothing → DENY;
 *  - the read itself fails (`AccessDecisionUnavailable`) → UNAVAILABLE, never a silent denial.
 */
export interface AccessRecordProjectionQuery {
  readonly moduleKey: ModuleKey;
  readonly recordKey: RecordKey;
  /** The trusted request scope; the reader answers only inside it and never trusts a body (O66). */
  readonly scope: OperationalScope;
}

export type AccessRecordProjectionPort = (
  query: AccessRecordProjectionQuery,
) => Effect.Effect<Option.Option<ListRowProjection>, AccessDecisionUnavailable>;

/**
 * A composition that bound no projection port projects nothing. Selector-bearing targets then deny
 * exactly as they do today (no owner fact, no match), while scope-wide work is unaffected — the honest
 * fail-closed default rather than an invented projection.
 */
export const UNPROJECTED_RECORD: AccessRecordProjectionPort = (_query) => Effect.succeed(Option.none());

/**
 * The one call the seam makes: ask the owner for the record a targeted decision names. An unbound port
 * answers "unprojected" without a read, so wiring the port is additive and never widens authority.
 */
export const readRecordProjection = (
  port: AccessRecordProjectionPort | undefined,
  query: AccessRecordProjectionQuery,
): Effect.Effect<Option.Option<ListRowProjection>, AccessDecisionUnavailable> =>
  port === undefined ? UNPROJECTED_RECORD(query) : port(query);
