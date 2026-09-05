// A9 governs run seams, not exports of namespaces used to compose typed Effects.
export * as Effect from 'effect';
export { Effect as Fx } from 'effect';
import { Effect as E } from 'effect';
export const program = E.succeed(1);
export { E };
