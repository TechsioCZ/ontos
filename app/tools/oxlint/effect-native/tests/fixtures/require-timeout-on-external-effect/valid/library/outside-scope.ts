// Outside `include` (`apps/**`, `verticals/**`, `packages/**`).
import { Effect } from 'effect';

declare const db: { read: () => Promise<string> };

export const unbounded = Effect.tryPromise(() => db.read());
