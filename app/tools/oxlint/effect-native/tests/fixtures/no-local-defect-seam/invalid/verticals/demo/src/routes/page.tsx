// expect-count: 2
// A9/A4: the browser route reclassifies the erased failure union after leaving Effect.
import { Cause, Effect } from 'effect';

declare const loadCustomers: Effect.Effect<readonly string[], never>;

const guarded = loadCustomers.pipe(
  Effect.catchCause((cause) =>
    Cause.hasDies(cause) ? Effect.succeed([] as readonly string[]) : Effect.failCause(cause),
  ),
);

export const CustomersPage = (): JSX.Element => <ul data-state={String(guarded)} />;
