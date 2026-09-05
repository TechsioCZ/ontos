// expect-count: 1
// Evasion: `.mts` script module.
import * as Schema from 'effect/Schema';

const Mode = Schema.Literals(['check', 'write']);
export const Config = Schema.Struct({ mode: Mode, fallback: Schema.Literals(['write', 'check']) });
