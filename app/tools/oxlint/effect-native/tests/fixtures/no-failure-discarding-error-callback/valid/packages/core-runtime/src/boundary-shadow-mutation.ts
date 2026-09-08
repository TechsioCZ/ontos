import { Effect } from 'effect';
export function shadow(Effect: {mapError: (f: () => string) => unknown}) { const E = Effect; return E.mapError(() => 'foreign'); }
let translate = Effect.mapError;
translate = ((f: unknown) => f) as typeof translate;
translate(() => 'unknown');
const key = 'other';
Effect.match({ [key]: () => 'not a failure callback', onFailure: (error: unknown) => error });
const overrides = {catch: (error: unknown) => error};
Effect.try({catch: () => 'overwritten', try: () => 1, ...overrides});
declare const computed: string;
Effect.try({catch: () => 'possibly overwritten', try: () => 1, [computed]: overrides.catch});
Effect.try({try: () => 1, get catch() { return overrides.catch; }});
const mutableOptions = { try: () => 1, catch: () => 'initial' };
mutableOptions.catch = ((error: unknown) => error) as () => string;
Effect.try(mutableOptions);
