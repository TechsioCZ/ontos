import { Effect } from "effect";

// A type reference whose last identifier does not match the dependency pattern is data.
interface ContactRow {
  readonly id: string;
}
export const Row = ({ id }: ContactRow) => <li>{id}</li>;

// Reading a dependency from the Effect context is the target, and is invisible here.
export const load = Effect.gen(function* () {
  const rows: readonly ContactRow[] = [];
  return rows;
});
