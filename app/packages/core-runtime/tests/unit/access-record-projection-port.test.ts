/**
 * R5a-7: the owner's record projection is the one source a record-scoped decision may use.
 *
 * These cases pin the port's own contract — an unbound port projects nothing, an answer flows through,
 * a read failure is UNAVAILABLE and never a silent denial — and tie the port's answer to the evaluator
 * the list path uses, so the two paths cannot disagree about the same record.
 */
import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { accessDecisionUnavailable } from '../../src/access/decision/errors.ts';
import { cellReachesProjection } from '../../src/access/decision/list-access.ts';
import type { ListRowProjection } from '../../src/access/decision/list-access.ts';
import { readRecordProjection, UNPROJECTED_RECORD } from '../../src/access/enforcement/record-projection-port.ts';
import type { AccessRecordProjectionQuery } from '../../src/access/enforcement/record-projection-port.ts';
import { ModuleKeySchema, PrincipalIdSchema, RecordKeySchema } from '../../src/access/ids.ts';
import type { Holder } from '../../src/access/model.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';

const HOLDER: Holder = {
  _tag: 'Principal',
  principalId: PrincipalIdSchema.make('11111111-1111-4111-8111-111111111111'),
};
const RECORD = RecordKeySchema.make('22222222-2222-4222-8222-222222222222');
const QUERY: AccessRecordProjectionQuery = {
  moduleKey: ModuleKeySchema.make('party.registry'),
  recordKey: RECORD,
  scope: {
    ...Schema.decodeSync(TrustedPrincipalContextSchema)({
      authBindingId: '33333333-3333-4333-8333-333333333333',
      authContextRef: 'better-auth-session:projection-port',
      authMethod: 'session',
      principalId: HOLDER.principalId,
      tenantId: '44444444-4444-4444-8444-444444444444',
    }),
    correlationId: 'projection-port',
  },
};
const PROJECTED: ListRowProjection = { assigned: HOLDER, recordKey: RECORD, teamIds: [] };
/** The owner has projected no record at all: the fail-closed case. */
const noProjection = (projection?: ListRowProjection): ListRowProjection | undefined => projection;
const NO_PROJECTION = noProjection();

it.effect('projects nothing when the composition bound no port, which denies a selector without a record fact', () =>
  Effect.gen(function* unprojectedRecord() {
    expect(Option.isNone(yield* UNPROJECTED_RECORD(QUERY))).toBe(true);
    // An unbound port is the same answer as an unbound seam: no owner fact, so nothing is reached.
    expect(Option.isNone(yield* readRecordProjection(undefined, QUERY))).toBe(true);
    expect(
      cellReachesProjection({ cell: { selector: { _tag: 'assigned' } }, holder: HOLDER, teamIds: [] }, NO_PROJECTION),
    ).toBe(false);
  }),
);

it.effect('hands the owner projection of the named record to the decision', () =>
  Effect.gen(function* projectedRecord() {
    const projection = Option.getOrUndefined(
      yield* readRecordProjection(
        (query) => Effect.succeed(Option.some({ ...PROJECTED, recordKey: query.recordKey })),
        QUERY,
      ),
    );
    expect(projection?.recordKey).toBe(RECORD);
    // The same projection reaches the record through the evaluator the list path uses, so a list and a
    // record-scoped decision answer identically for the same owner row.
    expect(
      cellReachesProjection({ cell: { selector: { _tag: 'assigned' } }, holder: HOLDER, teamIds: [] }, projection),
    ).toBe(true);
  }),
);

it.effect('fails closed with UNAVAILABLE when the projection read itself fails', () =>
  Effect.gen(function* unreadableProjection() {
    let unavailable = false;
    yield* readRecordProjection(
      () => Effect.fail(accessDecisionUnavailable('owner projection unreadable')),
      QUERY,
    ).pipe(
      // A broken read is an infrastructure failure (503), never a silent denial (O48).
      Effect.catchTag('AccessDecisionUnavailable', () => {
        unavailable = true;
        return Effect.void;
      }),
    );
    expect(unavailable).toBe(true);
  }),
);
