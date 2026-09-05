import { Effect } from 'effect';
import * as Library from 'effect';
type Port = { runPromise(value: number): number };
export function localNamespace(Effect: Port) {
  const E = Effect;
  const { runPromise: execute } = Effect;
  return [E.runPromise(1), execute(1)];
}
export function localBarrel(Library: { Effect: Port }) {
  const Fx = Library.Effect;
  return Fx.runPromise(1);
}
