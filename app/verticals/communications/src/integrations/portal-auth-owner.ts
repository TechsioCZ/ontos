import { executePortalAuthIssuanceSourceWithAuthorization } from '@app/portal-auth-contracts/portal-auth-issuance-source/client';
import {
  PortalAuthIssuanceSourceRequestSchema,
  PortalAuthIssuanceSourceResponseSchema,
} from '@app/portal-auth-contracts/portal-auth-issuance-source';
import type {
  PortalAuthIssuanceSourceRequest,
  PortalAuthIssuanceSourceResponse,
} from '@app/portal-auth-contracts/portal-auth-issuance-source';
import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';
import { Data, Effect, Layer, Option, Redacted, Schema } from 'effect';
import type { Duration } from 'effect';
import type { SecureRandom } from 'effect/crypto';

import { SourceStateKeySchema } from '../domain/catalog/vocabulary.ts';
import { safeCauseOf } from '../domain/intake/safe-cause.ts';
import { SourceOccurrenceAuthority } from '../domain/intake/source-authority.ts';
import type { SourceOccurrenceAuthorityService } from '../domain/intake/source-authority.ts';
import { SourceOccurrenceUnavailable } from '../domain/intake/source-authority-errors.ts';
import { RecipientAuthorityUnavailable } from '../domain/recipient/current-gate-errors.ts';
import { RecipientCurrentGate, RecipientGateVerdict } from '../domain/recipient/current-gate.ts';
import type { RecipientCurrentGateService, RecipientGateQuery } from '../domain/recipient/current-gate.ts';
import type { ProtectedEndpoint } from '../domain/recipient/original-binding.ts';
import { CurrentOwnerCall } from './owner-call.ts';
import type { OwnerCall } from './owner-call.ts';

/**
 * The live owner adapters of the three Portal Auth message types (#1406): Auth is the SOLE source owner of the issuance, so
 * Communications asks it again, at the decision and at the last stoppable handoff, through Auth's PUBLISHED owner Read
 * `commerce.customer-context.api.portal-auth-issuance-source` and never reads Auth's tables, store or private source. Each ask is
 * made under the authority of the operation in progress with a FRESH audience-scoped assertion, so no earlier answer is remembered
 * and no credential of Communications' own is used.
 *
 * The Read answers state and binding facts only. It never answers the address, token, one-time code or link, so a usable
 * endpoint built here carries an EMPTY protected value: the handoff transport (step 22) resolves the original address from Auth
 * itself and this adapter never has, stores or invents one.
 */

/**
 * Auth's own names, exactly as its published vocabulary states them (the approved catalog entries carry the same strings, and the
 * published answer schema names the state: the adapter tests assert it). Auth's private vocabulary file is not an importable
 * descriptor, so Communications states the three it needs.
 */
const PORTAL_AUTH_COMMUNICATION_SOURCE_MODULE = 'commerce.customer-context';
const PORTAL_AUTH_ENDPOINT_RESOURCE_TYPE = 'commerce.customer-context.portal-auth-endpoint';
export const PORTAL_AUTH_ISSUANCE_STATE_CURRENT = 'commerce.customer-context.portal-auth.issuance-current';

/** The topology app of the owner and the declaration of its Read (the published Read's own key). */
const PORTAL_AUTH_AUDIENCE = 'commerce-customer-context';
const PORTAL_AUTH_DECLARATION_KEY = 'commerce.customer-context.portal-auth-issuance-source.read';

/** A failed owner call: a published problem with its status, or any other failure to answer. */
type OwnerCallFailure = Error | { readonly status: number };

/**
 * How ONE question reaches Auth under the authority of the operation in progress. The production transport is Auth's public Read
 * through its generated client with a fresh delegated assertion; it is the only part a composition replaces, so the question,
 * the decoding of the answer and the verdict are always the code below.
 */
export type PortalAuthOwnerTransport = (
  request: PortalAuthIssuanceSourceRequest,
  call: OwnerCall,
) => Effect.Effect<unknown, OwnerCallFailure>;

/** The settings a deployment decides: the deadline of one ask; the domain has no default on purpose. */
export interface PortalAuthOwnerSettings {
  readonly checkTimeout: Duration.Input;
}

const decodeRequest = Schema.decodeUnknownOption(PortalAuthIssuanceSourceRequestSchema, { onExcessProperty: 'error' });
const decodeResponse = Schema.decodeUnknownOption(PortalAuthIssuanceSourceResponseSchema, {
  onExcessProperty: 'error',
});

/** One ask that produced no usable answer: no authority to ask under, no issuance to ask about, or an owner that did not answer. */
class PortalAuthOwnerAskFailed extends Data.TaggedError('PortalAuthOwnerAskFailed')<{
  readonly reason: 'NO_AUTHORITY' | 'NOT_AN_ISSUANCE' | 'OWNER_UNAVAILABLE';
}> {}

/** A typed failure that keeps only the SAFE kind of the failure it replaces: a failed call can carry the exact request. */
const failedBecause = <Failure extends object>(failure: Failure, cause: unknown): Failure =>
  Object.defineProperty(failure, 'cause', { enumerable: false, value: safeCauseOf(cause) });

const askFailed = (reason: PortalAuthOwnerAskFailed['reason'], cause?: unknown) =>
  cause === undefined
    ? new PortalAuthOwnerAskFailed({ reason })
    : failedBecause(new PortalAuthOwnerAskFailed({ reason }), cause);

/**
 * One ask: the request the published contract accepts, the answer it publishes, or nothing. A refused request names no issuance
 * Auth could know; an answer that does not decode names no fact. Neither is ever read as a state.
 */
interface PortalAuthQuestion {
  readonly issuanceRef: string;
  /** The Auth account the message is addressed to; absent for a source-state-only question. */
  readonly recipientSubjectId?: string;
}

const askAuth = Effect.fn('CommunicationsPortalAuthOwner.ask')(function* ask(
  transport: PortalAuthOwnerTransport,
  settings: PortalAuthOwnerSettings,
  question: PortalAuthQuestion,
) {
  const call = yield* CurrentOwnerCall;
  if (Option.isNone(call)) {
    return yield* askFailed('NO_AUTHORITY');
  }
  const request = decodeRequest(question);
  if (Option.isNone(request)) {
    return yield* askFailed('NOT_AN_ISSUANCE');
  }
  const answer = yield* transport(request.value, call.value).pipe(
    Effect.timeoutOption(settings.checkTimeout),
    Effect.mapError((cause) => askFailed('OWNER_UNAVAILABLE', cause)),
  );
  if (Option.isNone(answer)) {
    return yield* askFailed('OWNER_UNAVAILABLE');
  }
  const response = decodeResponse(answer.value);
  return Option.isNone(response) ? yield* askFailed('OWNER_UNAVAILABLE') : response.value;
});

/** The facts of the issuance the question named; an answer for another issuance is no answer. */
const factsOf = (response: PortalAuthIssuanceSourceResponse, issuanceRef: string) =>
  response.kind === 'FACTS' && response.issuanceRef === issuanceRef ? Option.some(response) : Option.none();

/**
 * The source occurrence Auth states: the occurrence is the issuance, its state is Auth's own lifecycle state of it, and an
 * issuance is never revised. Only Auth's own module answers; another source has no adapter, so it is an unavailable owner.
 */
export const portalAuthSourceOccurrenceAuthorityOver = (
  settings: PortalAuthOwnerSettings,
  transport: PortalAuthOwnerTransport,
): SourceOccurrenceAuthorityService => ({
  read: Effect.fn('CommunicationsPortalAuthOwner.readOccurrence')(function* readIssuance(request) {
    if (request.source.moduleKey !== PORTAL_AUTH_COMMUNICATION_SOURCE_MODULE) {
      return yield* new SourceOccurrenceUnavailable({ reason: 'OWNER_UNAVAILABLE' });
    }
    const issuanceRef = request.occurrence.occurrenceId;
    const response = yield* askAuth(transport, settings, { issuanceRef }).pipe(
      Effect.mapError((failure) =>
        failedBecause(
          new SourceOccurrenceUnavailable({
            reason: failure.reason === 'NOT_AN_ISSUANCE' ? 'OCCURRENCE_UNKNOWN' : 'OWNER_UNAVAILABLE',
          }),
          failure,
        ),
      ),
    );
    const facts = factsOf(response, issuanceRef);
    if (Option.isNone(facts)) {
      return yield* new SourceOccurrenceUnavailable({ reason: 'OCCURRENCE_UNKNOWN' });
    }
    return {
      latestRevision: facts.value.latestRevision,
      occurrenceId: request.occurrence.occurrenceId,
      state: SourceStateKeySchema.make(facts.value.state),
      tenantId: request.tenantId,
    };
  }),
});

/**
 * The Current gate of the ORIGINAL recipient and endpoint: the endpoint is usable only while Auth says the issuance is Current
 * and its original endpoint is still bound to the named account. The query names the original contact only, so there is no way
 * to ask about, or to be answered with, a replacement contact. Usable answers echo the contact and snapshot Auth resolved.
 */
export const portalAuthRecipientCurrentGateOver = (
  settings: PortalAuthOwnerSettings,
  transport: PortalAuthOwnerTransport,
): RecipientCurrentGateService => ({
  check: Effect.fn('CommunicationsPortalAuthOwner.checkRecipient')(function* checkRecipient(query: RecipientGateQuery) {
    const unavailable = new RecipientAuthorityUnavailable({ authority: 'SOURCE_OWNER' });
    const { contact } = query;
    // only Auth's own endpoint, evidenced by the issuance-time snapshot or the authoritative reference, is Auth's to answer
    if (
      query.sourceModule !== PORTAL_AUTH_COMMUNICATION_SOURCE_MODULE ||
      contact.contactRef.moduleId !== PORTAL_AUTH_COMMUNICATION_SOURCE_MODULE ||
      contact.contactRef.resourceType !== PORTAL_AUTH_ENDPOINT_RESOURCE_TYPE ||
      contact.evidence.kind === 'VERSIONED_SNAPSHOT'
    ) {
      return yield* unavailable;
    }
    const issuanceRef = contact.contactRef.resourceId;
    const response = yield* askAuth(transport, settings, {
      issuanceRef,
      recipientSubjectId: query.recipient.recipientRef.resourceId,
    }).pipe(
      Effect.mapError((failure) =>
        failedBecause(new RecipientAuthorityUnavailable({ authority: 'SOURCE_OWNER' }), failure),
      ),
    );
    if (response.kind === 'NO_FACTS') {
      // the issuance belongs to another account: nothing answers for this recipient
      return RecipientGateVerdict.Unusable({ reason: 'SOURCE_NO_LONGER_VALID' });
    }
    const facts = factsOf(response, issuanceRef);
    if (Option.isNone(facts)) {
      return yield* unavailable;
    }
    if (facts.value.state !== PORTAL_AUTH_ISSUANCE_STATE_CURRENT) {
      return RecipientGateVerdict.Unusable({ reason: 'SOURCE_NO_LONGER_VALID' });
    }
    const original = facts.value.originalEndpoint;
    if (original?.kind !== 'CURRENT') {
      return RecipientGateVerdict.Unusable({ reason: 'ORIGINAL_ENDPOINT_UNUSABLE' });
    }
    // the owner echoes the snapshot it resolved, exactly as the contact binding names it
    const endpoint: ProtectedEndpoint = {
      channel: 'email',
      contactRef: contact.contactRef,
      mask: original.mask,
      // Auth never discloses the address over its Read; the handoff transport resolves it from Auth itself
      value: Redacted.make(''),
    };
    return RecipientGateVerdict.Usable({
      endpoint:
        contact.evidence.kind === 'HISTORICAL_SNAPSHOT'
          ? { ...endpoint, snapshotRef: contact.evidence.snapshotRef }
          : endpoint,
    });
  }),
  checkTimeout: settings.checkTimeout,
});

/** The two Portal Auth owner ports over one transport: the explicit composition a test or a deployment supplies. */
export const portalAuthOwnerPortsOver = (settings: PortalAuthOwnerSettings, transport: PortalAuthOwnerTransport) =>
  Layer.mergeAll(
    Layer.succeed(SourceOccurrenceAuthority, portalAuthSourceOccurrenceAuthorityOver(settings, transport)),
    Layer.succeed(RecipientCurrentGate, portalAuthRecipientCurrentGateOver(settings, transport)),
  );

/**
 * Auth's PUBLIC Read through its generated client, with a fresh delegated assertion on EVERY ask under the authority of the
 * operation in progress (`CurrentOwnerCall`), naming the exact declaration of the Read it asks.
 */
export const portalAuthOwnerTransportLive =
  (crypto: SecureRandom.SecureRandom['Service']): PortalAuthOwnerTransport =>
  (request, call) =>
    acquireDelegatedGatewayContext(
      {
        audience: PORTAL_AUTH_AUDIENCE,
        legalEntityScope: 'subject',
        requestCorrelation: call.correlation(),
        subject: call.subjectFor({
          ask: 'AUTH_ISSUANCE_SOURCE',
          declarationKey: PORTAL_AUTH_DECLARATION_KEY,
          decodedRequest: request,
        }),
      },
      crypto,
    ).pipe(
      Effect.flatMap((issued) =>
        executePortalAuthIssuanceSourceWithAuthorization(request, issued.authorization, call.correlation(), {
          baseUrl: new URL(issued.apiBaseUrl),
          compositionRevision: issued.compositionRevision,
        }),
      ),
    );
