// expect-count: 6
export interface FormEntry {
  readonly key: string;
  readonly value: string | undefined;
}

// Named guard extracted out of the callback: no longer an inline array operation.
const isCompleteEntry = (entry: readonly [string, string | undefined]): entry is [string, string] =>
  entry[1] !== undefined && entry[1].length > 0;

// A callback handed to something that is not a collection operation.
const narrow = <Value,>(value: unknown, guard: (candidate: unknown) => candidate is Value) =>
  (guard(value) ? value : undefined);

const label = narrow('x', (candidate: unknown): candidate is string => typeof candidate === 'string');

class CustomerFormModel {
  isReady(state: unknown): state is FormEntry {
    return typeof state === 'object' && state !== null && 'key' in state;
  }
}

const readyGuard: (state: unknown) => state is FormEntry = (state): state is FormEntry =>
  typeof state === 'object' && state !== null;

export const CustomerForm = () => (
  <form data-label={label} data-ready={String(readyGuard({}))}>
    {isCompleteEntry(['a', 'b']) ? <span>ok</span> : null}
    <output>{new CustomerFormModel().isReady({}) ? 'ready' : 'pending'}</output>
  </form>
);
