import { Effect } from 'effect';

class ReadHandlerUnavailable {}
declare const load: () => Promise<string>;

// D tier: throwaway error mapping inside test fixtures is blessed by the audit.
export const owner = Effect.tryPromise({ try: load, catch: () => new ReadHandlerUnavailable() });
export const mapped = Effect.mapError(Effect.succeed(1), () => new ReadHandlerUnavailable());
