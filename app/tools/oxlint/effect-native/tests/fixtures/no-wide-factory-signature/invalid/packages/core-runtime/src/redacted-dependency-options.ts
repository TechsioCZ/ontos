// expect-count: 11
import { Effect, Redacted } from 'effect';
import { Redacted as FakeRedacted } from 'somewhere-else';
import type { ImportedService } from './service';

type Store = { readonly read: () => string };
interface ServiceOptions { readonly secret: Redacted.Redacted<Store> }
export const makeService = (options: ServiceOptions) => Effect.succeed(options);
interface CallbackOptions { readonly secret: Redacted.Redacted<() => string> }
export const makeCallback = (options: CallbackOptions) => Effect.succeed(options);
interface ImportedOptions { readonly secret: Redacted.Redacted<ImportedService> }
export const makeImported = (options: ImportedOptions) => Effect.succeed(options);
interface UnknownOptions { readonly secret: Redacted.Redacted<unknown> }
export const makeUnknown = (options: UnknownOptions) => Effect.succeed(options);
interface LookalikeOptions { readonly secret: FakeRedacted.Redacted<string> }
export const makeLookalike = (options: LookalikeOptions) => Effect.succeed(options);
interface OtherQualifiedOptions { readonly secret: Other.Data<string> }
export const makeOtherQualified = (options: OtherQualifiedOptions) => Effect.succeed(options);
namespace Local { export type Redacted<A = string> = A }
interface LocalOptions { readonly secret: Local.Redacted<string> }
export const makeLocal = (options: LocalOptions) => Effect.succeed(options);
export namespace Shadowed {
  export namespace Redacted { export type Redacted<A = string> = A }
  interface ShadowOptions { readonly secret: Redacted.Redacted<string> }
  export const makeShadowed = (options: ShadowOptions) => Effect.succeed(options);
}
export function host<Redacted>() {
  interface GenericOptions { readonly secret: Redacted.Redacted<string> }
  return { makeGeneric: (options: GenericOptions) => Effect.succeed(options) };
}
export const makeWideService = (secret: Redacted.Redacted<Store>, tenant: string, revision: number) =>
  Effect.succeed({ secret, tenant, revision });
interface EffectOptions { readonly secret: Redacted.Redacted<Effect.Effect<string>> }
export const makeEffect = (options: EffectOptions) => Effect.succeed(options);
