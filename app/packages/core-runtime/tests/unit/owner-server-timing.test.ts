import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { FetchHttpClient, HttpServerResponse } from 'effect/http';

import { OWNER_TIMING_METRICS, withOwnerServerTiming } from '../../src/http/owner-server-timing.ts';
import { servedResponse } from '../support/served-response.ts';

/*
 * An owner's caller (the Shell's approval routes) logs which owner was slowest and on what. The owner says what in
 * one `server-timing` header of fixed names and numbers, counted from its own spans, on every response it ends in.
 */

const span = (name: string) => Effect.void.pipe(Effect.withSpan(name));

/** An owner request's work: one gate batch over one SpiceDB call with its evidence, three statements in a transaction. */
const ownerWork = Effect.all(
  [
    Effect.all([span('AccessDecision.spicedbCheckBulk'), span('AccessDecisionLog.recordAll')]).pipe(
      Effect.withSpan('AccessDecisionGate.decideMany'),
    ),
    Effect.all([span('postgres'), span('postgres'), span('postgres')]).pipe(Effect.withSpan('sql.transaction')),
    span('an.unrelated.span'),
  ],
  { concurrency: 1 },
);

/** The header's metrics, each name with its value. */
const metricsOf = (header: string | undefined) =>
  new Map(
    (header ?? '').split(', ').map((metric) => {
      const [name = '', duration = ''] = metric.split(';dur=');
      return [name, Number(duration)] as const;
    }),
  );

it.layer(FetchHttpClient.layer)((suite) => {
  suite.effect('sends the owner phases of a request in server-timing, fixed names and numbers only', () =>
    Effect.gen(function* ownerPhases() {
      const response = yield* servedResponse(
        ownerWork.pipe(Effect.as(HttpServerResponse.text('ok')), withOwnerServerTiming),
      );
      expect(response.status).toBe(200);
      const metrics = metricsOf(response.headers['server-timing']);
      expect([...metrics.keys()]).toEqual([...OWNER_TIMING_METRICS]);
      expect(metrics.get('owner-gate-count')).toBe(1);
      expect(metrics.get('owner-spicedb-count')).toBe(1);
      expect(metrics.get('owner-sql-count')).toBe(3);
      expect(metrics.get('owner-transaction-count')).toBe(1);
      expect(metrics.get('owner-remote-count')).toBe(0);
      for (const value of metrics.values()) {
        expect(Number.isInteger(value) && value >= 0).toBe(true);
      }
    }),
  );

  suite.effect('sends them on a response the request failed into, too', () =>
    Effect.gen(function* failedOwnerPhases() {
      const response = yield* servedResponse(
        ownerWork.pipe(Effect.andThen(Effect.fail('unavailable')), withOwnerServerTiming),
      );
      expect(response.status).toBe(503);
      expect(metricsOf(response.headers['server-timing']).get('owner-sql-count')).toBe(3);
    }),
  );
});
