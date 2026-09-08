import { Effect } from 'effect';

/** One-shot scripts sit outside the Layer graph and are out of scope by default. */
export const createSeedRuntime = (database: unknown, gateway: unknown, clock: unknown, now: unknown) =>
  Effect.succeed({ clock, database, gateway, now });

export const buildSeedOptions = (options: SeedOptions) => Effect.gen(function* () {
  return options;
});
