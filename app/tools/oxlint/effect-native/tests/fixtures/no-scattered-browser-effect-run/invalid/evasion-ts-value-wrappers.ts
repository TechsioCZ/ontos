// expect-count: 3
// TypeScript value-position wrappers (`as`, `!`, `satisfies`) around the runner identifier.
import { getCustomerList, runEffectRequest } from '../contacts-api.ts';

type Runner = (effect: unknown) => Promise<unknown>;

export const cast = (runEffectRequest as Runner)(getCustomerList({ correlationId: 'static' }));
export const asserted = runEffectRequest!(getCustomerList({ correlationId: 'static' }));
export const satisfied = (runEffectRequest satisfies Runner)(
  getCustomerList({ correlationId: 'static' }),
);
