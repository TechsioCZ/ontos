// expect-count: 1
// A7 explicitly cites this application topology parser; *.config is not blanket build-host immunity.
import * as Schema from 'effect/Schema';
export function decode(value: unknown) { if (!Schema.is(Schema.String)(value)) throw new TypeError('invalid topology'); return value; }
