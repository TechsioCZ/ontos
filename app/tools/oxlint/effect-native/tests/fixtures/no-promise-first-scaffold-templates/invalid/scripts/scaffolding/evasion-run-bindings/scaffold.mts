// expect-count: 3
/**
 * A9/A1 evasion: the emitted module re-enters Effect exactly as A9 describes, but binds the runner
 * directly (`import { runPromise } from 'effect/Effect'`) or through an aliased namespace, so the
 * `Effect\.run…` prefix never appears in the emitted text.
 */
export const renderBoundary = (name: string): string => `import { runPromise, runSync } from 'effect/Effect';
import { Effect as Fx } from 'effect';

export const submit${name} = (payload: ${name}Payload) => runPromise(${name}Program(payload));

export const readConfig${name} = () => runSync(${name}ConfigProgram);

export const forkTelemetry${name} = () => Fx.runFork(${name}TelemetryProgram);
`;
