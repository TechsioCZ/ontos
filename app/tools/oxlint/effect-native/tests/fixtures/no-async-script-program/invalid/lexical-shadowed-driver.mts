// expect-count: 2
import { Effect } from "effect";
export function fake(Effect: { promise(callback: () => Promise<number>): unknown }) {
 return Effect.promise(async () => 1);
}
const facade = {runPromise: () => Promise.resolve(1)};
await facade.runPromise();
