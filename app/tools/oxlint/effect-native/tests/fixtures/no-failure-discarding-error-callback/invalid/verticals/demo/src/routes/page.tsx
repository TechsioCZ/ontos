// expect-count: 3
import { Effect } from 'effect';

class RouteFailure {}

declare const load: Effect.Effect<string, Error>;
declare const fetchJson: () => Promise<string>;

export function Page() {
  const safe = load.pipe(Effect.catchAllCause(() => Effect.succeed('')));
  const mapped = load.pipe(Effect.mapError(() => new RouteFailure()));
  const tried = Effect.try({ try: () => fetchJson(), catch: (_e: unknown) => new RouteFailure() });
  return <div>{String(safe)}{String(mapped)}{String(tried)}</div>;
}
