// A4 targets failure escape, not deferred data. D tier preserves framework Promise adapters.
import { Effect, Layer } from 'effect';
import { useMutation } from '@tanstack/react-query';
declare const Tag: unknown;
export const service = Layer.succeed(Tag, { run() { throw new Error('deferred service method'); } });
export const value = Effect.succeed(() => { throw new Error('deferred function value'); });
export const caught = Effect.sync(() => { try { throw 'local branch'; } catch { return 1; } });
export const framework = Effect.sync(() => useMutation({mutationFn: async () => { throw new Error('framework rejection'); }}));
