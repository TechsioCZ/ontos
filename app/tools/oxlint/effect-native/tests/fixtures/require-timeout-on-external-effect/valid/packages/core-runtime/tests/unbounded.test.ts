// Tests are out of scope (`includeTests: false`): B2 owns the Effect test harness.
import { Effect } from 'effect';

declare const db: { read: () => Promise<string> };

export const unbounded = Effect.tryPromise(() => db.read());
