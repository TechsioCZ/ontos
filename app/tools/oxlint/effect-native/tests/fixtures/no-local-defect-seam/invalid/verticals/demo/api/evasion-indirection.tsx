// expect-count: 7
// Indirection does not change the seam: class members, async generators, nested arrow bodies,
// callback references, default parameters and `satisfies`-wrapped references.
import { Cause, Effect } from 'effect';

declare const program: Effect.Effect<string, never>;
declare const internalProblem: () => { readonly _tag: 'Internal' };

export class ContactHandler {
  readonly handled = program.pipe(Effect.catchDefect(() => Effect.fail(internalProblem())));

  static split(cause: Cause.Cause<never>): boolean {
    return Cause.hasDies(cause);
  }

  async *drain(cause: Cause.Cause<never>): AsyncGenerator<boolean> {
    yield Cause.isInterrupted(cause);
  }
}

const seams = [Effect.sandbox];
const withDefault = (wrap = Effect.catchAllCause): unknown => wrap;
export const nested = (): (() => Effect.Effect<string, never>) => () =>
  program.pipe(Effect.catchSomeCause(() => undefined));
export const asserted = (Effect.catchCause satisfies unknown) as unknown;

export const Panel = (): JSX.Element => <div data-seams={String(seams.length + Number(withDefault !== null))} />;
