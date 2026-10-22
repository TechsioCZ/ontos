import type { GatewayContextResponse } from '@app/shared-contracts';
import { Clock, Deferred, Effect, MutableRef, Option } from 'effect';

import { shellAuthenticationApiContract } from '../../shared/api.ts';
import { DOCUMENT_GATEWAY_AUDIENCE_LIMIT } from '../../shared/document-gateway-api.ts';
import type { DocumentGatewayAssertion } from '../../shared/document-gateway-api.ts';
import { issueDocumentGatewayContexts } from '../api/auth-client.ts';

/**
 * The gateway assertions of one document, one per module audience its composition lists, held in memory only.
 *
 * Every remote asks the Shell for an assertion before its first read of a module. Asked one by one, a page that reads
 * five modules waited for five `/auth/gateway-context` round trips (1-3 s each on a loaded stage) before any read
 * could start. Server rendering embeds the document's assertions (see home-page-model.ts), a client-side navigation
 * obtains them in one batch while the page's target and remote load, and the browser request cache answers each
 * remote's request from here. When they near expiry, the first request renews all of them in one batch, which the
 * other remotes join.
 *
 * Nothing is persisted: sign-out and tenant or legal-entity switches reload the document, which drops them, and a new
 * composition revision replaces them. Each assertion keeps its own audience and lifetime; modules authorize every call.
 */

/** Matches the Shell issuer and the per-remote reuse: an assertion is used until this close to its expiry. */
const REUSE_MARGIN_MILLIS = 15_000;
/** A batch that has not answered by then is abandoned; remotes then ask for their assertion alone. */
const BATCH_TIMEOUT = '30 seconds';
/** A release composes far fewer deployments than one batch carries; this only bounds a pathological set. */
const BATCH_CONCURRENCY = 4;

type Answers = ReadonlyMap<string, GatewayContextResponse>;

type Slot =
  | { readonly batch: Deferred.Deferred<Answers>; readonly kind: 'pending' }
  | { readonly kind: 'ready'; readonly response: GatewayContextResponse };

interface DocumentAssertions {
  /** Audiences this document asks for; a renewal covers all of them together. */
  readonly audiences: Set<string>;
  readonly revision: string;
  readonly slots: Map<string, Slot>;
}

/** One document admits one release; a new revision starts an empty set. */
const documentAssertions = MutableRef.make(Option.none<DocumentAssertions>());

const inBrowser = () => 'document' in globalThis;

const usable = (response: GatewayContextResponse, now: number) => response.expiresAt * 1000 - now > REUSE_MARGIN_MILLIS;

const currentFor = (revision: string): Option.Option<DocumentAssertions> =>
  MutableRef.get(documentAssertions).pipe(Option.filter((current) => current.revision === revision));

const ownedFor = (revision: string): DocumentAssertions =>
  Option.getOrElse(currentFor(revision), () => {
    const fresh: DocumentAssertions = { audiences: new Set(), revision, slots: new Map() };
    MutableRef.set(documentAssertions, Option.some(fresh));
    return fresh;
  });

const assertionOf = ({ audience: _audience, ...response }: DocumentGatewayAssertion): GatewayContextResponse =>
  response;

const chunks = (audiences: readonly string[]): readonly (readonly string[])[] =>
  audiences.length <= DOCUMENT_GATEWAY_AUDIENCE_LIMIT
    ? [audiences]
    : [
        audiences.slice(0, DOCUMENT_GATEWAY_AUDIENCE_LIMIT),
        ...chunks(audiences.slice(DOCUMENT_GATEWAY_AUDIENCE_LIMIT)),
      ];

/** One batch request per chunk; a failed batch answers nothing, so its audiences fall back to single requests. */
const requestBatch = (revision: string, audiences: readonly string[]) =>
  Effect.forEach(
    chunks(audiences),
    (chunk) =>
      issueDocumentGatewayContexts(
        { audiences: chunk, compositionRevision: revision },
        { baseUrl: new URL(shellAuthenticationApiContract.apiPrefix, globalThis.location.origin) },
      ).pipe(
        Effect.map(({ assertions }) => assertions),
        Effect.timeout(BATCH_TIMEOUT),
        Effect.orElseSucceed((): readonly DocumentGatewayAssertion[] => []),
      ),
    { concurrency: BATCH_CONCURRENCY },
  ).pipe(
    Effect.map(
      (answers): Answers =>
        new Map(
          answers
            .flat()
            .flatMap((assertion) =>
              assertion.compositionRevision === revision ? [[assertion.audience, assertionOf(assertion)] as const] : [],
            ),
        ),
    ),
  );

const settle = (
  owned: DocumentAssertions,
  audiences: readonly string[],
  batch: Deferred.Deferred<Answers>,
  answers: Answers,
) =>
  Effect.sync(() => {
    for (const audience of audiences) {
      const slot = owned.slots.get(audience);
      if (slot?.kind === 'pending' && slot.batch === batch) {
        const response = answers.get(audience);
        if (response === undefined) {
          owned.slots.delete(audience);
        } else {
          owned.slots.set(audience, { kind: 'ready', response });
        }
      }
    }
  }).pipe(Effect.andThen(Deferred.succeed(batch, answers)));

/**
 * Makes sure every audience of the document (the given ones included) has an assertion or one on the way, with one
 * batch request for all that lack one. Returns at once; the batch runs detached so a cancelled navigation keeps it.
 */
export const warmDocumentGatewayAssertions = Effect.fn('DocumentGatewayAssertions.warm')(function* warmEffect(
  revision: string,
  audiences: readonly string[],
) {
  if (!inBrowser()) {
    return;
  }
  const owned = ownedFor(revision);
  for (const audience of audiences) {
    owned.audiences.add(audience);
  }
  const now = yield* Clock.currentTimeMillis;
  const missing = [...owned.audiences].filter((audience) => {
    const slot = owned.slots.get(audience);
    return slot === undefined || (slot.kind === 'ready' && !usable(slot.response, now));
  });
  if (missing.length === 0) {
    return;
  }
  const batch = yield* Deferred.make<Answers>();
  for (const audience of missing) {
    owned.slots.set(audience, { batch, kind: 'pending' });
  }
  yield* Effect.forkDetach(
    requestBatch(revision, missing).pipe(Effect.flatMap((answers) => settle(owned, missing, batch, answers))),
  );
});

/**
 * The document's assertion for an audience, waiting for a batch already on its way; renews the document's expiring
 * assertions in one batch first when needed. None for an audience outside the document, another revision, or when
 * the batch did not answer it: the caller then asks for that one assertion alone.
 */
export const documentGatewayAssertion = Effect.fn('DocumentGatewayAssertions.get')(function* getEffect(
  audience: string,
  revision: string,
) {
  const current = currentFor(revision);
  if (!inBrowser() || Option.isNone(current)) {
    return Option.none<GatewayContextResponse>();
  }
  const owned = current.value;
  const now = yield* Clock.currentTimeMillis;
  const known = owned.slots.get(audience);
  if (
    (known === undefined || (known.kind === 'ready' && !usable(known.response, now))) &&
    owned.audiences.has(audience)
  ) {
    yield* warmDocumentGatewayAssertions(revision, []);
  }
  const slot = owned.slots.get(audience);
  if (slot === undefined) {
    return Option.none<GatewayContextResponse>();
  }
  const response = Option.fromNullishOr(
    slot.kind === 'ready' ? slot.response : (yield* Deferred.await(slot.batch)).get(audience),
  );
  const answeredAt = yield* Clock.currentTimeMillis;
  return response.pipe(Option.filter((answer) => usable(answer, answeredAt)));
});

/** An audience a remote asked for alone joins the document's set, so the next renewal covers it in the batch. */
export const noteDocumentGatewayAudience = (audience: string, revision: string) =>
  Effect.sync(() => {
    Option.map(currentFor(revision), ({ audiences }) => audiences.add(audience));
  });

/**
 * Keeps the assertions server rendering embedded in the document. Called while the Shell renders, before routed module
 * pages mount and ask for them; an audience that already holds a usable assertion keeps it.
 */
export const seedDocumentGatewayAssertions = Effect.fn('DocumentGatewayAssertions.seed')(function* seedEffect(
  revision: string,
  assertions: readonly DocumentGatewayAssertion[],
) {
  if (!inBrowser()) {
    return;
  }
  const now = yield* Clock.currentTimeMillis;
  const owned = ownedFor(revision);
  for (const assertion of assertions) {
    owned.audiences.add(assertion.audience);
    const slot = owned.slots.get(assertion.audience);
    const response = assertionOf(assertion);
    if (
      assertion.compositionRevision === revision &&
      usable(response, now) &&
      (slot === undefined || (slot.kind === 'ready' && !usable(slot.response, now)))
    ) {
      owned.slots.set(assertion.audience, { kind: 'ready', response });
    }
  }
});

/** Drops every held assertion. Tests call it between cases. */
export const resetDocumentGatewayAssertions = Effect.sync(() => MutableRef.set(documentAssertions, Option.none()));
