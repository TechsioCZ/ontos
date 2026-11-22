import { Context, Schema } from 'effect';
import type { DateTime, Effect, Option } from 'effect';

import type { PortalAuthIssuanceRef } from '../../../shared/portal-auth-communications.ts';
import type { PortalAuthCommunicationUnavailable } from './communication-unavailable.ts';
import type { PortalAuthIssuanceStateUnavailable } from './issuance-state-unavailable.ts';
import type { PortalAuthIssuance } from './issuance.ts';

/** Auth's own settlement of an issuance; once set it never changes. */
export const IssuanceSettlementSchema = Schema.Literals(['CONSUMED', 'REVOKED', 'SUPERSEDED']);
export type IssuanceSettlement = typeof IssuanceSettlementSchema.Type;

/** One issuance as Auth stored it: the safe facts, its settlement and its SEALED protected value (absent once cleared). */
export interface StoredIssuance {
  readonly issuance: PortalAuthIssuance;
  readonly sealedValue: Option.Option<string>;
  readonly settled: Option.Option<IssuanceSettlement>;
}

/** One due outbox row the relay holds under its lease: the stored request text and its issuance's expiry. */
export interface ClaimedCommunicationRequest {
  readonly attempts: number;
  readonly expiresAt: DateTime.Utc;
  readonly issuanceRef: PortalAuthIssuanceRef;
  readonly request: string;
}

/**
 * How a relayed row ends: Communications DECIDED it (a stored decision, whatever it says), recorded a CONFLICT for it, or Auth
 * itself saw the issuance EXPIRE before its request could be submitted (nothing is submitted then).
 */
export const CommunicationRequestCompletionSchema = Schema.Literals(['CONFLICT', 'DECIDED', 'EXPIRED']);
export type CommunicationRequestCompletion = typeof CommunicationRequestCompletionSchema.Type;

export interface PortalAuthCommunicationStoreService {
  /**
   * Takes up to `limit` PENDING rows of the Tenant that are due and not under a live lease, oldest first, skipping rows another
   * relay holds locked, and leases them to `leaseOwner` until `now + leaseMillis`, counting one more attempt on each.
   */
  readonly claimDue: (input: {
    readonly leaseMillis: number;
    readonly leaseOwner: string;
    readonly limit: number;
    readonly now: DateTime.Utc;
    readonly tenantId: string;
  }) => Effect.Effect<readonly ClaimedCommunicationRequest[], PortalAuthCommunicationUnavailable>;
  /**
   * Ends a row the caller still leases, with the safe outcome summary, and clears the issuance's protected value when `forget`.
   * Answers false when the row is no longer this caller's (another relay took it over, or it already ended).
   */
  readonly complete: (input: {
    readonly forget: boolean;
    readonly issuanceRef: PortalAuthIssuanceRef;
    readonly leaseOwner: string;
    readonly now: DateTime.Utc;
    readonly outcome: Option.Option<string>;
    readonly state: CommunicationRequestCompletion;
  }) => Effect.Effect<boolean, PortalAuthCommunicationUnavailable>;
  readonly find: (
    issuanceRef: PortalAuthIssuanceRef,
  ) => Effect.Effect<Option.Option<StoredIssuance>, PortalAuthIssuanceStateUnavailable>;
  /** Clears the protected value: nothing can complete the issuance's slot any more. */
  readonly forget: (issuanceRef: PortalAuthIssuanceRef) => Effect.Effect<void, PortalAuthIssuanceStateUnavailable>;
  /** Clears every protected value whose issuance has expired; answers how many were cleared. */
  readonly forgetExpired: (now: DateTime.Utc) => Effect.Effect<number, PortalAuthCommunicationUnavailable>;
  /**
   * ONE Auth transaction: the issuance with its sealed value, its Communication Request in the Auth-local outbox and, when the
   * flow replaces earlier issuances, the SUPERSEDED settlement of every earlier unsettled issuance of the same flow and subject
   * (their protected values cleared). Either everything is committed or nothing is.
   */
  readonly record: (input: {
    readonly issuance: PortalAuthIssuance;
    readonly now: DateTime.Utc;
    readonly request: string;
    readonly sealedValue: string;
    readonly supersede: boolean;
    readonly tenantId: string;
  }) => Effect.Effect<void, PortalAuthCommunicationUnavailable>;
  /** Returns a row the caller still leases to the due set at `availableAt`, recording a closed failure code. */
  readonly release: (input: {
    readonly availableAt: DateTime.Utc;
    readonly failure: string;
    readonly issuanceRef: PortalAuthIssuanceRef;
    readonly leaseOwner: string;
    readonly now: DateTime.Utc;
  }) => Effect.Effect<boolean, PortalAuthCommunicationUnavailable>;
  /** Auth's own lifecycle event; the protected value is cleared with it. A settled issuance keeps its first settlement. */
  readonly settle: (input: {
    readonly issuanceRef: PortalAuthIssuanceRef;
    readonly state: 'CONSUMED' | 'REVOKED';
  }) => Effect.Effect<void, PortalAuthIssuanceStateUnavailable>;
}

/** Auth's own durable record of the issuances it routes through Communications and of their requests (D1, D2). */
export class CommercePortalAuthCommunicationStore extends Context.Service<
  CommercePortalAuthCommunicationStore,
  PortalAuthCommunicationStoreService
>()(
  '@app/commerce-customer-context/portal-auth/communications/communication-store/CommercePortalAuthCommunicationStore',
) {}
