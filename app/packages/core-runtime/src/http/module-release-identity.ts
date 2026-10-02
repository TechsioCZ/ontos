import { Duration, Effect, Schema } from 'effect';

export class ModuleReleaseIdentityError extends Schema.TaggedError<ModuleReleaseIdentityError>()(
  'ModuleReleaseIdentityError',
  { cause: Schema.Defect() },
) {}

/** The native Shell BFF owns this ingress; release identity is data, never an arbitrary owner URL. */
export const moduleReleaseApiBaseUrl = (appId: string, buildMarker: string): string =>
  `/shell-super-app-api/module-api/${encodeURIComponent(appId)}/${encodeURIComponent(buildMarker)}/${appId}-api`;

/** Provider placement identity: both deployment and dispatch hash the exact approved release. */
export const moduleReleaseWorkerName = (appId: string, buildMarker: string) =>
  Effect.tryPromise({
    catch: (cause) => new ModuleReleaseIdentityError({ cause }),
    try: globalThis.crypto.subtle.digest.bind(
      globalThis.crypto.subtle,
      'SHA-256',
      new TextEncoder().encode(`${appId}\0${buildMarker}`),
    ),
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(5),
      orElse: () => Effect.fail(new ModuleReleaseIdentityError({ cause: 'Release identity hashing timed out' })),
    }),
    Effect.map((digest) => {
      const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      return `ontos-${hex.slice(0, 56)}`;
    }),
  );

/** A public assets-only Worker has the same exact release identity and no business executable. */
export const moduleReleaseAssetWorkerName = (appId: string, buildMarker: string) =>
  moduleReleaseWorkerName(appId, buildMarker).pipe(Effect.map((name) => `assets-${name.slice('ontos-'.length)}`));
