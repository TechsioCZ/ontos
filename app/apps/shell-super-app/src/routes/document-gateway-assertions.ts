import type { GatewayContextResponse } from '@app/shared-contracts';
import { Clock, Deferred, Effect, MutableRef, Option } from 'effect';

import { shellAuthenticationApiContract } from '../../shared/browser-api.ts';
import {
  DOCUMENT_GATEWAY_ASSERTION_LIMIT,
  DOCUMENT_GATEWAY_ASSERTIONS_PER_AUDIENCE,
} from '../../shared/document-gateway-api.ts';
import type { DocumentGatewayAssertion } from '../../shared/document-gateway-api.ts';
import { issueDocumentGatewayContexts } from '../api/auth-client.ts';

/**
 * The gateway assertions of one document, a small pool per module audience its composition lists, held in memory only.
 *
 * Every remote asks the Shell for an assertion before its first read of a module. Asked one by one, a page that reads
 * five modules waited for five `/auth/gateway-context` round trips (1-3 s each on a loaded stage) before any read
 * could start. The Shell obtains a document's assertions in one batch as soon as it renders (and a client-side
 * navigation while the page's target and remote load), and the browser request cache answers each remote's request
 * from here. Each assertion is claimed once. An audience whose pool runs dry is refilled in a batch that asks for the
 * reads waiting for one and a single spare (at most `DOCUMENT_GATEWAY_ASSERTIONS_PER_AUDIENCE`): a list that warms its
 * rows' details takes a few batches instead of one round trip per read, while a page that reads one row at a time
 * mints no assertions it never uses. Concurrent consumers never share a token.
 *
 * Nothing is persisted: sign-out and tenant or legal-entity switches reload the document, which drops them, and a new
 * composition revision replaces them. Each assertion keeps its own audience and lifetime; modules authorize every call.
 *
 * Owners redeem each assertion exactly once: a second presentation is refused with 401. So a token leaves this module
 * at most once.
 */

/** Leave enough lifetime for a claimed assertion to reach its owner. */
const EXPIRY_MARGIN_MILLIS = 15_000;
/** A batch that has not answered by then is abandoned; remotes then ask for their assertion alone. */
const BATCH_TIMEOUT = '30 seconds';
/** A release composes far fewer deployments than one batch carries; this only bounds a pathological set. */
const BATCH_CONCURRENCY = 4;
/** A read waits for at most this many refills of its audience before it asks for its assertion alone. */
const CLAIM_ROUNDS = 2;
/**
 * One assertion beyond the reads waiting, so a trickle of reads costs one batch per two reads instead of one each: the
 * spare is handed to the next read. The refill is never sized by what the document used over its lifetime; every
 * assertion is signed and registered on the Shell, and one nobody claims only expires.
 */
const REFILL_SPARE = 1;

/** One batch request: how many assertions it asks per audience. It grows until the request leaves. */
interface Batch {
  readonly wanted: Map<string, number>;
}

interface Pool {
  /** Assertions on their way to this pool in batches already asked. */
  expected: number;
  readonly ready: GatewayContextResponse[];
  /** Settles with how many assertions the batch that settled it added, then is replaced. */
  settled: Deferred.Deferred<number>;
  /** Reads waiting for this pool's next batch. */
  waiting: number;
}

interface DocumentAssertions {
  /** Audiences this document asks for; a renewal covers all of them together. */
  readonly audiences: Set<string>;
  /** The batch still collecting what it asks for; it leaves at the next turn of the scheduler. */
  open: Batch | null;
  readonly pools: Map<string, Pool>;
  readonly revision: string;
}

/** One document admits one release; a new revision starts an empty set. */
const documentAssertions = MutableRef.make(Option.none<DocumentAssertions>());

/** Revisions the Shell no longer issues for (a release switch); their documents must reload, so no batch is asked. */
const retiredRevisions = MutableRef.make(new Set<string>());

/** The Shell's own "reload required" answer, as the browser request cache buffers it. */
export interface RefusedReleaseAnswer {
  readonly body: ArrayBuffer;
  readonly headers: Readonly<Record<string, string>>;
  readonly status: number;
  readonly statusText: string;
}

/**
 * The first "reload required" answer the Shell gave for a revision. Once a document's release was refused, nothing
 * of it asks the Shell again: every further gateway request of that revision is answered with this refusal until the
 * page reloads, so an old tab shows its reload banner instead of sending a refused request every few seconds.
 */
const refusedReleases = MutableRef.make(new Map<string, RefusedReleaseAnswer>());

export const rememberRefusedRelease = (revision: string, answer: RefusedReleaseAnswer) =>
  Effect.sync(() => {
    MutableRef.get(retiredRevisions).add(revision);
    MutableRef.get(refusedReleases).set(revision, answer);
  });

/** The refusal a document of this revision answers with instead of asking the Shell; none while it is admitted. */
export const refusedReleaseAnswer = (revision: string): Option.Option<RefusedReleaseAnswer> =>
  Option.fromUndefinedOr(MutableRef.get(refusedReleases).get(revision));

const inBrowser = () => 'document' in globalThis;

const usable = (response: GatewayContextResponse, now: number) =>
  response.expiresAt * 1000 - now > EXPIRY_MARGIN_MILLIS;

const currentFor = (revision: string): Option.Option<DocumentAssertions> =>
  MutableRef.get(documentAssertions).pipe(Option.filter((current) => current.revision === revision));

const ownedFor = (revision: string): DocumentAssertions =>
  Option.getOrElse(currentFor(revision), () => {
    const fresh: DocumentAssertions = { audiences: new Set(), open: null, pools: new Map(), revision };
    MutableRef.set(documentAssertions, Option.some(fresh));
    return fresh;
  });

const poolOf = (owned: DocumentAssertions, audience: string): Pool => {
  const known = owned.pools.get(audience);
  if (known !== undefined) {
    return known;
  }
  const fresh: Pool = { expected: 0, ready: [], settled: Deferred.makeUnsafe<number>(), waiting: 0 };
  owned.pools.set(audience, fresh);
  return fresh;
};

/** Drops the assertions too close to their expiry to hand out; they are never handed out again. */
const prune = (pool: Pool, now: number) => {
  const fresh = pool.ready.filter((response) => usable(response, now));
  pool.ready.splice(0, pool.ready.length, ...fresh);
};

const assertionOf = ({ audience: _audience, ...response }: DocumentGatewayAssertion): GatewayContextResponse =>
  response;

/** The entries of a batch: each audience repeated as often as the batch asks for its assertions. */
const entriesOf = (batch: Batch): readonly string[] =>
  [...batch.wanted].flatMap(([audience, count]) => Array.from({ length: count }, () => audience));

const chunks = (entries: readonly string[]): readonly (readonly string[])[] =>
  entries.length <= DOCUMENT_GATEWAY_ASSERTION_LIMIT
    ? [entries]
    : [entries.slice(0, DOCUMENT_GATEWAY_ASSERTION_LIMIT), ...chunks(entries.slice(DOCUMENT_GATEWAY_ASSERTION_LIMIT))];

/** One batch request per chunk; a failed batch answers nothing, so its audiences fall back to single requests. */
const requestBatch = (revision: string, entries: readonly string[]) =>
  Effect.forEach(
    chunks(entries),
    (chunk) =>
      issueDocumentGatewayContexts(
        { audiences: chunk, compositionRevision: revision },
        { baseUrl: new URL(shellAuthenticationApiContract.apiPrefix, globalThis.location.origin) },
      ).pipe(
        Effect.map(({ assertions }) => assertions),
        Effect.timeout(BATCH_TIMEOUT),
        Effect.catchTag('GatewayReloadRequiredProblem', () =>
          Effect.sync((): readonly DocumentGatewayAssertion[] => {
            MutableRef.get(retiredRevisions).add(revision);
            return [];
          }),
        ),
        Effect.orElseSucceed((): readonly DocumentGatewayAssertion[] => []),
      ),
    { concurrency: BATCH_CONCURRENCY },
  ).pipe(Effect.map((answers) => answers.flat().filter((assertion) => assertion.compositionRevision === revision)));

/** Adds each answered assertion to its pool, never more than the batch asked for, and wakes the reads waiting there. */
const settle = Effect.fn('DocumentGatewayAssertions.settle')(function* settleEffect(
  owned: DocumentAssertions,
  batch: Batch,
  answers: readonly DocumentGatewayAssertion[],
) {
  const woken = [...batch.wanted].map(([audience, wanted]) => {
    const pool = poolOf(owned, audience);
    const answered = answers
      .filter((assertion) => assertion.audience === audience)
      .slice(0, wanted)
      .map(assertionOf);
    pool.ready.push(...answered);
    pool.expected = Math.max(0, pool.expected - wanted);
    const { settled } = pool;
    pool.settled = Deferred.makeUnsafe<number>();
    return [settled, answered.length] as const;
  });
  yield* Effect.forEach(woken, ([settled, answered]) => Deferred.succeed(settled, answered), {
    concurrency: 1,
    discard: true,
  });
});

/**
 * Reserves `count` more assertions of an audience in the batch still collecting, opening a new one when there is none
 * or it already carries as many of the audience as one request may. Returns the batches it opened: each must be sent.
 */
const reserve = (owned: DocumentAssertions, audience: string, count: number): readonly Batch[] => {
  if (count <= 0) {
    return [];
  }
  const open: Batch = owned.open ?? { wanted: new Map() };
  const opened = owned.open === open ? [] : [open];
  owned.open = open;
  const asked = open.wanted.get(audience) ?? 0;
  const added = Math.min(count, DOCUMENT_GATEWAY_ASSERTIONS_PER_AUDIENCE - asked);
  open.wanted.set(audience, asked + added);
  poolOf(owned, audience).expected += added;
  if (added < count) {
    // This batch carries as many of the audience's assertions as one request may; the rest go in the next.
    owned.open = null;
  }
  return [...opened, ...reserve(owned, audience, count - added)];
};

/** Sends an opened batch, detached so a cancelled navigation keeps it, once the reads of this turn joined it. */
const send = (owned: DocumentAssertions, batch: Batch) =>
  Effect.forkDetach(
    Effect.yieldNow.pipe(
      Effect.andThen(
        Effect.suspend(() => {
          if (owned.open === batch) {
            owned.open = null;
          }
          return requestBatch(owned.revision, entriesOf(batch));
        }),
      ),
      Effect.flatMap((answers) => settle(owned, batch, answers)),
    ),
  );

/**
 * Asks one assertion for every audience of the document that holds none and has none on the way, and `refill` more of
 * the audience a read is waiting for, all in the batch still collecting.
 */
const fillEmpty = Effect.fn('DocumentGatewayAssertions.fillEmpty')(function* fillEmptyEffect(
  owned: DocumentAssertions,
  now: number,
  refill: { readonly audience: string; readonly count: number } | null,
) {
  const opened = [...owned.audiences].flatMap((audience) => {
    if (audience === refill?.audience) {
      return reserve(owned, audience, refill.count);
    }
    const pool = poolOf(owned, audience);
    prune(pool, now);
    return pool.ready.length === 0 && pool.expected === 0 ? reserve(owned, audience, 1) : [];
  });
  yield* Effect.forEach(opened, (batch) => send(owned, batch), { concurrency: 1, discard: true });
});

/**
 * Makes sure every audience of the document (the given ones included) has an assertion or one on the way, with one
 * batch request for all that lack one. Returns at once; the batch runs detached so a cancelled navigation keeps it.
 */
export const warmDocumentGatewayAssertions = Effect.fn('DocumentGatewayAssertions.warm')(function* warmEffect(
  revision: string,
  audiences: readonly string[],
) {
  if (!inBrowser() || MutableRef.get(retiredRevisions).has(revision)) {
    return;
  }
  const owned = ownedFor(revision);
  for (const audience of audiences) {
    owned.audiences.add(audience);
  }
  yield* fillEmpty(owned, yield* Clock.currentTimeMillis, null);
});

/** One claim round: hand out a held assertion, or ask a refill and wait for the next batch of this audience. */
const claim = Effect.fn('DocumentGatewayAssertions.claim')(function* claimEffect(
  owned: DocumentAssertions,
  audience: string,
  round: number,
): Effect.fn.Return<Option.Option<GatewayContextResponse>> {
  const pool = poolOf(owned, audience);
  const now = yield* Clock.currentTimeMillis;
  prune(pool, now);
  // Claim synchronously: only this caller removes this assertion.
  const claimed = pool.ready.shift();
  if (claimed !== undefined) {
    return Option.some(claimed);
  }
  if (
    round === CLAIM_ROUNDS ||
    !owned.audiences.has(audience) ||
    MutableRef.get(retiredRevisions).has(owned.revision)
  ) {
    return Option.none<GatewayContextResponse>();
  }
  if (pool.waiting >= pool.expected) {
    // Ask for the reads waiting here that no batch covers yet (this one included) and one spare, never more.
    const count = Math.min(
      DOCUMENT_GATEWAY_ASSERTIONS_PER_AUDIENCE,
      Math.max(1, pool.waiting + 1 - pool.expected) + REFILL_SPARE,
    );
    yield* fillEmpty(owned, now, { audience, count });
  }
  pool.waiting += 1;
  const answered = yield* Deferred.await(pool.settled).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        pool.waiting -= 1;
      }),
    ),
  );
  if (answered === 0 && pool.ready.length === 0) {
    // The batch answered none of this audience (a failure or a refusal): the single issuer says why.
    return Option.none<GatewayContextResponse>();
  }
  return yield* claim(owned, audience, round + 1);
});

/**
 * One of the document's assertions for an audience, handed to this caller only. A dry pool is refilled in a batch
 * (with the document's other empty audiences); a read waits for a batch already on its way when it carries enough
 * for every read waiting. None for an audience outside the document, another revision, or when the batches did not
 * answer it: the caller then asks for that one assertion alone.
 */
export const documentGatewayAssertion = Effect.fn('DocumentGatewayAssertions.get')(function* getEffect(
  audience: string,
  revision: string,
) {
  const current = currentFor(revision);
  if (!inBrowser() || Option.isNone(current) || MutableRef.get(retiredRevisions).has(revision)) {
    return Option.none<GatewayContextResponse>();
  }
  return yield* claim(current.value, audience, 0);
});

/** An audience a remote asked for alone joins the document's set, so the next renewal covers it in the batch. */
export const noteDocumentGatewayAudience = (audience: string, revision: string) =>
  Effect.sync(() => {
    Option.map(currentFor(revision), ({ audiences }) => audiences.add(audience));
  });

/** Drops every held assertion at a context boundary (and between test cases). */
export const resetDocumentGatewayAssertions = Effect.sync(() => MutableRef.set(documentAssertions, Option.none()));
