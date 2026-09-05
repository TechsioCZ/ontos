// expect-count: 5
// Shapes that must stay covered: class members, async generators, casts, optional chaining and JSX.
import { Effect as EffectRuntime } from 'effect';

import { getCustomerList, runEffectRequest } from '../contacts-api.ts';

export class CustomerStore {
  readonly refresh = () => runEffectRequest(getCustomerList({ correlationId: 'static' }));

  async load() {
    return EffectRuntime.runPromise(getCustomerList({ correlationId: 'static' }));
  }

  static readonly booted = EffectRuntime?.['runFork'](getCustomerList({ correlationId: 'static' }));
}

export async function* streamCustomers() {
  yield await (EffectRuntime.runPromise as (effect: never) => Promise<never>)(
    getCustomerList({ correlationId: 'static' }) as never,
  );
}

export const Panel = () => (
  <button onClick={() => void EffectRuntime.runSync(getCustomerList({ correlationId: 'static' }))} type="button">
    refresh
  </button>
);
