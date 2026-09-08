// expect-count: 1
import { Effect } from 'effect';

export const makeLegalEntityScopeAccess = async (seed: string) => ({
  legalEntities: (id: string): Promise<string> => Promise.resolve(`${seed}:${id}`),
});

/** Factory-derived contract behind `Awaited<…>`; still only ever handed to callers positionally. */
export type LegalEntityScopeAccess = Awaited<ReturnType<typeof makeLegalEntityScopeAccess>>;

export const resolveScope = (access: LegalEntityScopeAccess): Effect.Effect<string, Error> =>
  Effect.promise(() => access.legalEntities('a'));
