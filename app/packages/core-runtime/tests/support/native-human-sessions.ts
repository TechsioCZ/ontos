import { Context, Schema } from 'effect';
import type { Crypto, Effect, FileSystem, Scope } from 'effect';

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
