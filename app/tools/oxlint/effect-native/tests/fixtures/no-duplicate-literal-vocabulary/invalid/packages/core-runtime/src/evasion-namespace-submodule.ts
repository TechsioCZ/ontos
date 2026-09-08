// expect-count: 2
// Evasion: `import * as Schema from "effect/Schema"` namespace import, three anonymous copies.
import * as Schema from 'effect/Schema';

export const RequestPayload = Schema.Struct({ status: Schema.Literals(['queued', 'running', 'settled']) });
export const ResponsePayload = Schema.Struct({ status: Schema.Literals(['settled', 'queued', 'running']) });
export const AuditRow = Schema.Struct({ status: Schema.Literals(['running', 'settled', 'queued']) });
