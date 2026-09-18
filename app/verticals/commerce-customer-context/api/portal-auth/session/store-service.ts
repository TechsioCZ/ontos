import { Context } from 'effect';

import type { Effect, Option } from 'effect';

import type { CommercePortalAuthSessionRefreshConflict, CommercePortalAuthSessionUnavailable } from './errors.ts';
import type { CommercePortalAuthSessionRecord } from './contracts.ts';

export interface CommercePortalAuthSessionStore {
  readonly countActive: (input: {
    readonly absoluteLifetimeSeconds: number;
    readonly now: Date;
    readonly providerSubjectId: string;
  }) => Effect.Effect<number, CommercePortalAuthSessionUnavailable>;
  readonly disableAccount: (providerSubjectId: string) => Effect.Effect<boolean, CommercePortalAuthSessionUnavailable>;
  readonly findById: (
    sessionId: string,
  ) => Effect.Effect<Option.Option<CommercePortalAuthSessionRecord>, CommercePortalAuthSessionUnavailable>;
  readonly findByToken: (
    token: string,
  ) => Effect.Effect<Option.Option<CommercePortalAuthSessionRecord>, CommercePortalAuthSessionUnavailable>;
  readonly revoke: (input: {
    readonly providerSubjectId?: string;
    readonly sessionId: string;
  }) => Effect.Effect<boolean, CommercePortalAuthSessionUnavailable>;
  readonly revokeAll: (providerSubjectId: string) => Effect.Effect<number, CommercePortalAuthSessionUnavailable>;
  readonly rotate: (input: {
    readonly expectedProviderSubjectId?: string;
    readonly expiresAt: Date;
    readonly now: Date;
    readonly sessionId: string;
  }) => Effect.Effect<
    Option.Option<CommercePortalAuthSessionRecord>,
    CommercePortalAuthSessionUnavailable | CommercePortalAuthSessionRefreshConflict
  >;
  readonly touch: (input: {
    readonly expectedUpdatedAt: Date;
    readonly expiresAt: Date;
    readonly now: Date;
    readonly sessionId: string;
  }) => Effect.Effect<Option.Option<CommercePortalAuthSessionRecord>, CommercePortalAuthSessionUnavailable>;
}

export class CommercePortalAuthSessionStoreService extends Context.Service<
  CommercePortalAuthSessionStoreService,
  CommercePortalAuthSessionStore
>()('@app/commerce-customer-context/api/portal-auth/session/store-service/CommercePortalAuthSessionStoreService') {}
