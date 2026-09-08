import { Cause, Effect } from 'effect';
import { expect, test as base } from '@playwright/test';

// Playwright must not abandon setup before Effect closes its scope. The stalled
// acquisition must finalize before reporting its typed timeout and must never complete.
const stalledAcquisitionDeadline = '250 millis';

const test = base.extend<Record<never, never>, { stalledAcquisition: readonly string[] }>({
  stalledAcquisition: [
    async ({ browserName: _browserName }, use) => {
      const events: string[] = [];
      // Mirrors the real fixture: finalizers are registered before the work that can stall.
      const acquisition = Effect.gen(function* stalledAcquisitionEffect() {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            events.push('finalizer');
          }),
        );
        return yield* Effect.never;
      });
      const failure = await Effect.runPromise(
        Effect.flip(
          Effect.gen(function* useStalledAcquisition() {
            yield* Effect.timeout(acquisition, stalledAcquisitionDeadline);
            events.push('acquired');
          }).pipe(Effect.scoped),
        ),
      );
      expect(failure).toBeInstanceOf(Cause.TimeoutError);
      events.push('reported timeout');
      await use(events);
    },
    { scope: 'worker', timeout: 0 },
  ],
});

test('finishes installed finalizers before reporting a stalled acquisition', ({
  stalledAcquisition,
}) => {
  expect(stalledAcquisition).toEqual(['finalizer', 'reported timeout']);
});
