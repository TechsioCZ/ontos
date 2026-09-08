// expect-count: 12
// The same unbounded bridge parked in every syntactic position a rule can trip over.
import { Effect } from 'effect';

declare const db: { read: () => Promise<string> };
declare const Panel: (props: { children?: unknown }) => unknown;

export class Repository {
  static readonly boot = Effect.tryPromise(() => db.read());
  readonly load = () => Effect.tryPromise(() => db.read());
  fetch() {
    return Effect.tryPromise(() => db.read());
  }
  #secret() {
    return Effect.promise(async () => await db.read());
  }
  static {
    void Effect.tryPromise(() => db.read());
  }
}

export async function* rows() {
  yield await Effect.runPromise(Effect.tryPromise(() => db.read()));
}

export const curried = () => () => Effect.tryPromise(() => db.read());

export const widened = Effect.tryPromise(() => db.read()) as Effect.Effect<string, unknown>;
export const checked = Effect.tryPromise(() => db.read()) satisfies Effect.Effect<string, unknown>;
export const asserted = Effect.promise(async () => await db.read())!;

export const Rendered = () => (
  <Panel children={Effect.tryPromise(() => db.read())}>
    {String(Effect.promise(async () => await db.read()))}
  </Panel>
);
