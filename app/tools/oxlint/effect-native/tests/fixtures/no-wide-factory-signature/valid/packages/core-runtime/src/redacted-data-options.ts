import { Effect, Redacted } from 'effect';
import { Redacted as Secret } from 'effect';
import * as E from 'effect';
import type * as SecretModule from 'effect/Redacted';
import type { Redacted as SecretValue } from 'effect/Redacted';

interface NativeReadOptions {
  readonly connections: {
    readonly admin: Redacted.Redacted;
    readonly runtime: { readonly connectionString: Redacted.Redacted<string> };
  };
}
export const makeNativeRead = (options: NativeReadOptions) => Effect.succeed(options);
interface AliasOptions { readonly credential: Secret.Redacted<{ readonly token: string; readonly expires: number }> }
export const createAliased = (options: AliasOptions) => Effect.succeed(options);
interface NamespaceOptions { readonly credential: E.Redacted.Redacted<string> }
export const buildNamespaced = (options: NamespaceOptions) => Effect.succeed(options);
interface SubmoduleOptions { readonly credential: SecretModule.Redacted<string> }
export const makeSubmodule = (options: SubmoduleOptions) => Effect.succeed(options);
interface DirectOptions { readonly credential: SecretValue<string> }
export const makeDirect = (options: DirectOptions) => Effect.succeed(options);
export const makeWideSecretData = (secret: Redacted.Redacted, tenant: string, revision: number) =>
  Effect.succeed({ secret, tenant, revision });
