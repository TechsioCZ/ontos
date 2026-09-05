// expect-count: 4
import { Context, Effect, Layer } from 'effect';

// B4: matching spelling across namespaces is not matching a lexical contract.
export namespace Wired {
  export interface SessionService { load(): Effect.Effect<string>; }
  export class Session extends Context.Service<Session, SessionService>()('wired') {}
}
export namespace Unwired {
  export interface SessionService { load(): Effect.Effect<string>; }
}

// An assertion buried in another service's operation does not provide this contract.
export interface HiddenService { read(): Effect.Effect<string>; }
export const other = Context.GenericTag<{ other(): Effect.Effect<unknown> }>('other');
export const live = Layer.succeed(other, {
  other: () => Effect.succeed({ read: () => Effect.succeed('hidden') } satisfies HiddenService),
});

// An opaque tag and an unrelated layer must not suppress either contract.
export interface OpaqueNeighbourService { read(): Effect.Effect<string>; }
export class Marker extends Context.Reference<Marker>()('marker', { defaultValue: () => 1 }) {}
export interface ShadowedService { read(): Effect.Effect<string>; }
export function fakeTag(Context: { GenericTag: <A>(key: string) => unknown }) {
  return Context.GenericTag<ShadowedService>('fake');
}
