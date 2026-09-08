// Server-only module that happens to live under a browser glob (`serverGlobs`): a process seam
// here is the audit-blessed single outer adapter, governed by `no-bare-effect-run`, not by this
// browser rule. Never reported by `no-scattered-browser-effect-run`.
import { Effect } from 'effect';

import { makePool } from '../../db-pool.ts';

export const pool = Effect.runSync(makePool);
