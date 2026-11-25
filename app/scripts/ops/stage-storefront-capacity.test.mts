import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { probeCapacity } from './stage-storefront-capacity.mts';

it.effect('counts failures and performs one warm read plus the fixed-target burst', () =>
  Effect.gen(function* countedProbe() {
    const calls = new Map<string, number>();
    const reports = yield* probeCapacity({
      concurrency: 4,
      probe: (target) =>
        Effect.sync(() => {
          const call = (calls.get(target.label) ?? 0) + 1;
          calls.set(target.label, call);
          return { label: target.label, problems: call === 3 ? ['HTTP 502'] : [] };
        }),
    });
    expect(reports).toHaveLength(3);
    for (const report of reports) {
      expect(calls.get(report.label)).toBe(5);
      expect(report.passed).toBe(3);
      expect(report.failed).toBe(1);
      expect(report.problems).toEqual(['HTTP 502']);
    }
  }),
);

it.effect('rejects unbounded or fractional loads without starting public work', () =>
  Effect.gen(function* invalidProbe() {
    for (const concurrency of [0, -1, 1.5, 33, Infinity]) {
      const error = yield* probeCapacity({
        concurrency,
        probe: () => Effect.die('must not start work'),
      }).pipe(Effect.flip);
      expect(error).toMatchObject({ reason: 'invalid-concurrency' });
    }
  }),
);
