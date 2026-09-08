// A local barrel re-exporting the throwing decoder lets every consumer import it from a
// non-Effect specifier, which the rule can no longer recognise.
export { decodeUnknownSync, encodeSync } from 'effect/Schema';
