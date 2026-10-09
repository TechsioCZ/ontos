import { Context } from 'effect';

import type { Effect, Option } from 'effect';

import type { CommercePortalAuthAuditEvent } from '../../../src/portal-auth/audit/audit-contracts.ts';
import type { CommercePortalAuthSessionRefreshConflict, CommercePortalAuthSessionUnavailable } from './errors.ts';
import type { CommercePortalAuthSessionRecord } from './contracts.ts';

/**
 * The audited half of a mutating store call. The store writes this row inside the same transaction
 * as the state change, and only when the transaction actually changed state: a refused insert rolls
 * the mutation back and the call fails `CommercePortalAuthSessionUnavailable`, so a committed
 * revocation, disable, rotation or renewal can never exist without its evidence row. A call that
 * changed nothing writes nothing — that outcome is a decision, and the caller records it through
 * the lenient recorder instead.
 */
export interface CommercePortalAuthSessionAudited {
  readonly audit: CommercePortalAuthAuditEvent;
}

export interface CommercePortalAuthSessionStore {
  readonly countActive: (input: {
    readonly absoluteLifetimeSeconds: number;
    readonly now: Date;
    readonly providerSubjectId: string;
  }) => Effect.Effect<number, CommercePortalAuthSessionUnavailable>;
  readonly disableAccountWithAudit: (
    input: CommercePortalAuthSessionAudited & { readonly providerSubjectId: string },
  ) => Effect.Effect<boolean, CommercePortalAuthSessionUnavailable>;
  readonly findById: (
    sessionId: string,
  ) => Effect.Effect<Option.Option<CommercePortalAuthSessionRecord>, CommercePortalAuthSessionUnavailable>;
  readonly findByToken: (
    token: string,
  ) => Effect.Effect<Option.Option<CommercePortalAuthSessionRecord>, CommercePortalAuthSessionUnavailable>;
  /**
   * Un-audited single-session revoke. The sign-in admission path uses it to undo the provider
   * session it just refused: that whole attempt is one decision, published as one sign-in event by
   * the transport. Every owner-initiated revocation uses `revokeWithAudit`.
   */
  readonly revoke: (input: {
    readonly providerSubjectId?: string;
    readonly sessionId: string;
  }) => Effect.Effect<boolean, CommercePortalAuthSessionUnavailable>;
  readonly revokeAllWithAudit: (
    input: CommercePortalAuthSessionAudited & { readonly providerSubjectId: string },
  ) => Effect.Effect<number, CommercePortalAuthSessionUnavailable>;
  readonly revokeWithAudit: (
    input: CommercePortalAuthSessionAudited & {
      readonly providerSubjectId?: string;
      readonly sessionId: string;
    },
  ) => Effect.Effect<boolean, CommercePortalAuthSessionUnavailable>;
  readonly rotateWithAudit: (
    input: CommercePortalAuthSessionAudited & {
      /**
       * Stamped on the replacement row when this rotation is itself a fresh authentication. Left
       * out, the replacement carries the source row's value forward, so a rotation that proves
       * nothing new about the customer cannot make a stale session look recently authenticated.
       */
      readonly authenticatedAt?: Date;
      /**
       * Written in the rotation transaction, after its own row, so it never commits without the
       * rotation.
       */
      readonly completion?: CommercePortalAuthAuditEvent;
      readonly expectedProviderSubjectId?: string;
      readonly expiresAt: Date;
      readonly now: Date;
      readonly sessionId: string;
    },
  ) => Effect.Effect<
    Option.Option<CommercePortalAuthSessionRecord>,
    CommercePortalAuthSessionUnavailable | CommercePortalAuthSessionRefreshConflict
  >;
  /**
   * Un-audited inactivity renewal, used by the sign-in admission path to bind a just-minted
   * session's expiry to policy. An explicit refresh uses `touchWithAudit`.
   */
  readonly touch: (input: {
    readonly expectedUpdatedAt: Date;
    readonly expiresAt: Date;
    readonly now: Date;
    readonly sessionId: string;
  }) => Effect.Effect<Option.Option<CommercePortalAuthSessionRecord>, CommercePortalAuthSessionUnavailable>;
  readonly touchWithAudit: (
    input: CommercePortalAuthSessionAudited & {
      readonly expectedUpdatedAt: Date;
      readonly expiresAt: Date;
      readonly now: Date;
      readonly sessionId: string;
    },
  ) => Effect.Effect<Option.Option<CommercePortalAuthSessionRecord>, CommercePortalAuthSessionUnavailable>;
}

export class CommercePortalAuthSessionStoreService extends Context.Service<
  CommercePortalAuthSessionStoreService,
  CommercePortalAuthSessionStore
>()('@app/commerce-customer-context/api/portal-auth/session/store-service/CommercePortalAuthSessionStoreService') {}
