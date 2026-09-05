// expect-count: 2
// Evasion probe: `allowInlineCallbacks` exempts a bare-identifier callee whose name is a collection
// operation (the `pipe(xs, filter(fn))` shape) without checking that the identifier is an Effect
// collection import. A local helper named `every`/`find` that *returns* its argument therefore lets a
// reusable, exported domain predicate escape the rule entirely.
declare function handWritten(value: unknown): boolean;

export interface Contact {
  readonly id: string;
}

const every = <Guard>(guard: Guard): Guard => guard;
const find = <Guard>(guard: Guard): Guard => guard;

export const isContact = every((value: unknown): value is Contact => handWritten(value));
export const isContactAgain = find((value: unknown): value is Contact => handWritten(value));
