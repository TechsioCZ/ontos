// The same member set that appears three times in invalid/.../evasion-namespace-submodule.ts.
// A single occurrence here proves per-file state does not leak between files.
import * as Schema from 'effect/Schema';

export const AuditRow = Schema.Struct({ status: Schema.Literals(['settled', 'queued', 'running']) });
