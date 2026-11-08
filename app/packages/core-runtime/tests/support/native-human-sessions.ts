import {
  Config,
  Context,
  DateTime,
  Effect,
  FileSystem,
  Function as Fn,
  Layer,
  Path,
  Predicate,
  Redacted,
  Schema,
} from 'effect';
import type { Crypto, Scope } from 'effect';

import type { AccessDecisionService } from '../../src/access/enforcement/contract.ts';
import type { TrustedPrincipalContext } from '../../src/actions/principal-context.ts';
import type { CoreDatabase } from '../../src/db/client.ts';
import type { DatabaseIdentityConnections } from '../../src/db/config.ts';
import type { DatabaseIdentityEnrollment } from '../../src/db/database-identities.ts';
import type { ContextAccessService } from '../../src/permissions/context-access.ts';

/** Structural TEST-only protocol. Core never imports Shell or its private authentication implementation. */
const NativeHumanSessionFixtureErrorValue = Schema.TaggedError<unknown>()('NativeHumanSessionFixtureError', {
  cause: Schema.optionalKey(Schema.Redacted(Schema.Defect())),
  reason: Schema.String,
});
export type NativeHumanSessionFixtureError = InstanceType<typeof NativeHumanSessionFixtureErrorValue>;
export { NativeHumanSessionFixtureErrorValue as NativeHumanSessionFixtureError };

export interface NativeHumanSessionExpectation {
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}
export interface NativeHumanSessionIdentity {
  readonly authBindingId: string;
  readonly principal: TrustedPrincipalContext;
  readonly providerSubjectId: string;
  readonly sessionId: string;
}
export interface NativeHumanSessionHandle {
  readonly authenticate: (
    expected?: NativeHumanSessionExpectation,
  ) => Effect.Effect<NativeHumanSessionIdentity, NativeHumanSessionFixtureError>;
  readonly authenticateTenant: () => Effect.Effect<NativeHumanSessionIdentity, NativeHumanSessionFixtureError>;
  readonly revokeBinding: () => Effect.Effect<void, NativeHumanSessionFixtureError>;
  readonly signOut: () => Effect.Effect<void, NativeHumanSessionFixtureError>;
}
export interface NativeHumanSessionProviderOptions {
  readonly accessDecision: AccessDecisionService;
  readonly bindHumanProviderSubject: (input: {
    readonly authenticationNamespaceId: string;
    readonly principalId: string;
    readonly providerSubjectId: string;
    readonly tenantId: string;
    readonly verifyProviderSubject: Effect.Effect<void, NativeHumanSessionFixtureError>;
  }) => Effect.Effect<{ readonly authBindingId: string }, NativeHumanSessionFixtureError>;
  readonly connections: DatabaseIdentityConnections;
  readonly contextAccess: ContextAccessService;
  readonly coreDatabase: (typeof CoreDatabase)['Service'];
  readonly enrollment: DatabaseIdentityEnrollment;
  readonly revokeBinding: (authBindingId: string) => Effect.Effect<void, NativeHumanSessionFixtureError>;
}
export interface NativeHumanSessionProvider {
  readonly create: (
    input: NativeHumanSessionExpectation & { readonly displayName: string },
  ) => Effect.Effect<NativeHumanSessionHandle, NativeHumanSessionFixtureError>;
}
type NativeHumanSessionsMake = (
  options: NativeHumanSessionProviderOptions,
) => Effect.Effect<
  NativeHumanSessionProvider,
  NativeHumanSessionFixtureError,
  Crypto.Crypto | FileSystem.FileSystem | Scope.Scope
>;
export class NativeHumanSessionsFactory extends Context.Service<
  NativeHumanSessionsFactory,
  { readonly make: NativeHumanSessionsMake }
>()('@app/core-runtime/tests/support/native-human-sessions/NativeHumanSessionsFactory') {}

const unavailable = (cause?: unknown) =>
  new NativeHumanSessionFixtureErrorValue({
    cause: Redacted.make(cause),
    reason: 'The owned session provider is unavailable',
  });
const factoryExport = 'makeNativeHumanSessionProvider';
const ModuleSchema = Schema.Struct({
  makeNativeHumanSessionProvider: Schema.declare<NativeHumanSessionsMake>((value): value is NativeHumanSessionsMake =>
    Predicate.isFunction(value),
  ),
});
const ManifestSchema = Schema.fromJsonString(
  Schema.Struct({
    factoryExport: Schema.Literal(factoryExport),
    moduleUrl: Schema.String,
    ownerDirectory: Schema.String,
  }),
);

/** Only a runner-created local module inside its live owned-temp lease can supply this test dependency. */
export const loadNativeHumanSessionsFactory = Effect.fn('NativeHumanSessions.loadFactory')(function* load(
  ownedDirectory: string,
  moduleUrl: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(ownedDirectory).pipe(Effect.mapError(unavailable));
  const url = yield* Schema.decodeUnknownEffect(Schema.URLFromString)(moduleUrl).pipe(Effect.mapError(unavailable));
  if (url.protocol !== 'file:' || url.host !== '' || url.search !== '' || url.hash !== '') {
    return yield* unavailable();
  }
  const filename = yield* path.fromFileUrl(url).pipe(Effect.mapError(unavailable));
  const real = yield* fs.realPath(filename).pipe(Effect.mapError(unavailable));
  if (real !== filename || path.dirname(real) !== root || path.basename(real) !== 'native-human-sessions.mjs') {
    return yield* unavailable();
  }
  const marker = yield* fs.readFileString(path.join(root, '.disk-guardian-owner')).pipe(Effect.mapError(unavailable));
  const fields = new Map(
    marker
      .trim()
      .split('\n')
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  const now = (yield* DateTime.nowAsDate).getTime() / 1000;
  const created = Number(fields.get('created_epoch'));
  const expires = Number(fields.get('expires_epoch'));
  if (
    fields.size !== 5 ||
    fields.get('version') !== '1' ||
    fields.get('path') !== root ||
    !/^[1-9]\d*$/u.test(fields.get('owner_pid') ?? '') ||
    !Number.isSafeInteger(created) ||
    !Number.isSafeInteger(expires) ||
    created > now ||
    expires <= now ||
    created >= expires
  ) {
    return yield* unavailable();
  }
  const manifest = yield* fs
    .readFileString(path.join(root, '.native-human-sessions.json'))
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ManifestSchema)), Effect.mapError(unavailable));
  if (manifest.ownerDirectory !== root || manifest.moduleUrl !== url.href) {
    return yield* unavailable();
  }
  const module = yield* Effect.suspend(() =>
    Effect.tryPromise(
      Fn.constant(
        import(
          /* webpackIgnore: true */
          url.href
        ),
      ),
    ),
  ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ModuleSchema)), Effect.mapError(unavailable));
  return { make: module.makeNativeHumanSessionProvider };
});

export const NativeHumanSessionsFactoryLive = Layer.effect(
  NativeHumanSessionsFactory,
  Effect.gen(function* configuredFactory() {
    const owned = yield* Config.String('OWNED_TEMP_DIR').pipe(Effect.mapError(unavailable));
    const url = yield* Config.String('ONTOS_NATIVE_HUMAN_SESSIONS_MODULE_URL').pipe(Effect.mapError(unavailable));
    return yield* loadNativeHumanSessionsFactory(owned, url);
  }),
);
