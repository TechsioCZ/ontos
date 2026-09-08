// `scripts/` is out of scope (`includeScripts: false`): B3 owns the script migration.
import { Effect } from 'effect';

declare const db: { read: () => Promise<string> };

export const unbounded = Effect.tryPromise(() => db.read());
