import { Effect } from "effect";
interface Row { id: string }
type Maybe = Row | undefined;
export namespace Local {
  type Maybe = Row;
  export interface Repo { load(): Promise<Maybe> }
}
export interface Generic<Maybe> { load(): Promise<Maybe> }
type Outcome<A> = Promise<A | undefined>;
export interface GenericPorts { load(): Outcome<void> }
export interface UnknownOutcome { load(): Promise<Row | unknown | null>; any(): Promise<Row | any | undefined> }
export function adapter<Effect, Promise>(callback: () => Promise) { return callback(); }
// A local generic named Promise is not a native async outcome wrapper.
export namespace Driver {
  interface Promise<A> { value: A }
  export interface Reader { load(): Promise<Row | undefined> }
}
