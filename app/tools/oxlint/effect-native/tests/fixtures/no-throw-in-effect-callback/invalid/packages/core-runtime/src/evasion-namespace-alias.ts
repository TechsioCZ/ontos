// expect-count: 2
// EVASION (currently missed): the combinator is reached through a module-local alias instead of the
// import binding itself. `import { gen } from "effect/Effect"` is already recognised, so the
// equivalent `const { gen } = Effect` (and `const Fx = Eff.Effect`) should be too — `getScope` can
// follow both to the same import.
import * as Eff from 'effect';

const Fx = Eff.Effect;
const { gen } = Fx;

export const aliased = Fx.sync(() => {
  throw new Error('aliased namespace, same `effect` binding');
});

export const destructured = gen(function* () {
  throw new Error('destructured combinator, same `effect` binding');
});
