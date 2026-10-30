// @effect-diagnostics asyncFunction:off -- Browser fetch transport boundary: the wrapper implements `typeof fetch`, whose contract is a Promise; cache logic stays in Effect. expires: 2027-03-31.
import {
  GatewayContextResponseSchema,
  getDocumentCompositionRevision,
  makeOperationGateway,
} from '@app/shared-contracts';
import { moduleWriteEvent, pageDataWorkEvent } from '@app/shared-contracts/page-data';
import type { PageDataWork } from '@app/shared-contracts/page-data';
import { Clock, Deferred, Effect, Exit, Fiber, Match, MutableRef, Option, Predicate, Schema } from 'effect';

import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import {
  documentGatewayAssertion,
  noteDocumentGatewayAudience,
  resetDocumentGatewayAssertions,
} from './document-gateway-assertions.ts';

/**
 * One in-memory cache per document for the browser's module traffic, installed by the Shell around `fetch`.
 *
 * Every remote bundles its own copy of the generated clients, so a cache inside those clients would be one cache
 * per remote. `fetch` is the seam they all share: module reads (`/module-api/…/reads/…` and `…/search/…`) are
 * answered from memory, concurrent identical reads share one request, and gateway assertions are reused across
 * remotes until shortly before they expire. Any other module request is a write: once it settles, every cached
 * read is dropped and `moduleWriteEvent` is dispatched, so a user never sees their own change missing.
 *
 * The reads a page makes right after it opens are remembered per path (in `localStorage`, without credentials), so
 * a later preload of that path can issue them before the click.
 */

/** A read this young is served without asking the module again. */
const READ_FRESH_MILLIS = 20_000;
/** A write can start follow-up work in other modules (a won opportunity issues an invoice); reads this soon after are not kept. */
const WRITE_QUIET_MILLIS = 5000;
/** Matches the Shell issuer: an assertion is reused until this close to its expiry. */
const ASSERTION_REUSE_MARGIN_MILLIS = 15_000;
/** Reads that start this long after a page's first read belong to user interaction, not to opening the page. */
const VISIT_RECORD_MILLIS = 4000;
const RECORDED_READS_LIMIT = 24;
const READ_ENTRY_LIMIT = 256;
const PREFETCH_CONCURRENCY = 8;
const MANIFEST_PREFIX = 'ontos.page-reads.v1:';
/** Bounds background waits, never the lifetime of underlying owner or transport work. */
const BACKGROUND_WAIT_LIMIT = '30 seconds';

interface BufferedResponse {
  readonly body: ArrayBuffer;
  readonly headers: Readonly<Record<string, string>>;
  readonly status: number;
  readonly statusText: string;
}

class ModuleRequestFailed extends Schema.TaggedError<ModuleRequestFailed>()('ModuleRequestFailed', {
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

type BufferedFiber = Fiber.Fiber<BufferedResponse, ModuleRequestFailed>;

interface ReadEntry {
  readonly fiber: BufferedFiber;
  readonly primary: boolean;
  readonly startedAt: number;
}

const RecordedReadSchema = Schema.Struct({
  audience: Schema.String,
  body: Schema.String,
  compositionRevision: Schema.String,
  contentType: Schema.String,
  url: Schema.String,
});
type RecordedRead = typeof RecordedReadSchema.Type;
const RecordedReadsJson = Schema.fromJsonString(Schema.Array(RecordedReadSchema));
const GatewayRequestJson = Schema.fromJsonString(Schema.Struct({ audience: Schema.String }));
const DocumentGatewayRequestJson = Schema.fromJsonString(
  Schema.Struct({
    audience: Schema.String,
    compositionRevision: Schema.String,
    legalEntityId: Schema.optionalKey(Schema.Unknown),
  }),
);
const GatewayAssertionJson = Schema.fromJsonString(GatewayContextResponseSchema);
const textEncoder = new TextEncoder();
const GatewayResponseJson = Schema.fromJsonString(Schema.Struct({ expiresAt: Schema.Finite, token: Schema.String }));

interface Visit {
  readonly pathname: string;
  readonly reads: RecordedRead[];
  readonly startedAt: number;
}

interface CacheState {
  readonly assertions: Map<string, BufferedFiber>;
  /** Issued assertion token to its audience, so a recorded read knows which assertion to ask for later. */
  readonly audiences: Map<string, string>;
  /** A context switch or sign-out rejects pending work rather than restarting it under the old authority. */
  contextGeneration: number;
  /** Bumped by every settled write; an overtaken read must restart. */
  generation: number;
  readonly original: typeof globalThis.fetch;
  /** Reads that start before this instant are not kept (see WRITE_QUIET_MILLIS). */
  quietUntil: number;
  readonly reads: Map<string, ReadEntry>;
  visit?: Visit;
}

interface ModuleRead {
  readonly audience: string | undefined;
  readonly body: string;
  readonly compositionRevision: string;
  readonly contentType: string;
  readonly init: RequestInit;
  readonly url: string;
}

type ClassifiedRequest =
  | { readonly body: string; readonly init: RequestInit; readonly kind: 'gateway'; readonly url: string }
  | { readonly kind: 'pass' }
  | { readonly kind: 'read'; readonly read: ModuleRead }
  | { readonly kind: 'write' };

const pass: ClassifiedRequest = { kind: 'pass' };
const textDecoder = new TextDecoder();

const bodyText = (body: RequestInit['body']): string | undefined => {
  if (body === undefined || body === null) {
    return '';
  }
  if (Predicate.isString(body)) {
    return body;
  }
  return ArrayBuffer.isView(body) ? textDecoder.decode(body) : undefined;
};

// Effect clients pass a string or `URL`. A `Request` object carries its own body and headers and passes through.
const requestHref = (input: RequestInfo | URL): string | undefined => {
  if (Predicate.isString(input)) {
    return input;
  }
  return Predicate.hasProperty(input, 'url') ? undefined : input.href;
};

const requestUrl = (input: RequestInfo | URL): URL | undefined => {
  const href = requestHref(input);
  const url = href === undefined ? null : URL.parse(href, globalThis.location.href);
  return url === null || url.origin !== globalThis.location.origin ? undefined : url;
};

// One document admits one composition revision, so the URL and body identify the answer.
const readKey = ({ body, url }: Pick<ModuleRead, 'body' | 'url'>) => `${url}\n${body}`;

const moduleRead = (state: CacheState, url: URL, body: string, init: RequestInit): ModuleRead => {
  const headers = new Headers(init.headers);
  const token = (headers.get('authorization') ?? '').replace(/^Bearer\s+/iu, '');
  return {
    audience: state.audiences.get(token),
    body,
    compositionRevision: headers.get('x-ontos-composition-revision') ?? '',
    contentType: headers.get('content-type') ?? 'application/json',
    init,
    url: url.href,
  };
};

const classify = (state: CacheState, input: RequestInfo | URL, init: RequestInit = {}): ClassifiedRequest => {
  const url = requestUrl(input);
  const method = (init.method ?? 'GET').toUpperCase();
  const body = bodyText(init.body);
  if (url === undefined || method === 'GET' || method === 'HEAD') {
    return pass;
  }
  if (url.pathname.endsWith('/auth/gateway-context')) {
    return body === undefined ? pass : { body, init, kind: 'gateway', url: url.href };
  }
  if (!url.pathname.includes('/module-api/')) {
    return pass;
  }
  return /\/(?:reads|search)\//u.test(url.pathname) && body !== undefined
    ? { kind: 'read', read: moduleRead(state, url, body, init) }
    : { kind: 'write' };
};

const toResponse = ({ body, headers, status, statusText }: BufferedResponse): Response =>
  new Response([101, 204, 205, 304].includes(status) ? null : body, { headers, status, statusText });

/** Recorder exclusion is not a scheduler or authority. Concurrent preparations never wait for one another. */
const preparations = MutableRef.make(0);

/** Detached revalidation retains its own exclusion without extending the public preload wait. */
const retainPageDataWork = (work: PageDataWork): void => {
  MutableRef.update(preparations, (count) => count + 1);
  work.onSettled(() => {
    MutableRef.update(preparations, (count) => count - 1);
  });
};

/** Keep exclusion for the owner's Promise and all its detached loads, even if its caller stops waiting. */
export const withoutRecordedPageReads = <A>(start: () => Promise<A>) =>
  Effect.tryPromise(async () => {
    MutableRef.update(preparations, (count) => count + 1);
    try {
      return await start();
    } finally {
      MutableRef.update(preparations, (count) => count - 1);
    }
  }).pipe(Effect.timeout(BACKGROUND_WAIT_LIMIT));

// The shared request runs detached from any one caller, so it must not carry that caller's abort signal.
const bufferedFetch = (state: CacheState, url: string, { signal: _callerSignal, ...init }: RequestInit) =>
  Effect.tryPromise({
    catch: (cause) => new ModuleRequestFailed({ cause }),
    try: async () => {
      // Interrupting a superseded dataset stops its continuation, not a shared transport. Retain exclusion
      // until the real response body settles, even if every caller has stopped waiting (or timed out).
      const excluded = MutableRef.get(preparations) > 0;
      if (excluded) {
        MutableRef.update(preparations, (count) => count + 1);
      }
      try {
        const response = await state.original(url, init);
        return {
          body: await response.arrayBuffer(),
          headers: Object.fromEntries(response.headers),
          status: response.status,
          statusText: response.statusText,
        } satisfies BufferedResponse;
      } finally {
        if (excluded) {
          MutableRef.update(preparations, (count) => count - 1);
        }
      }
    },
  }).pipe(
    Effect.timeout(BACKGROUND_WAIT_LIMIT),
    Effect.catchTag('TimeoutError', (cause) => Effect.fail(new ModuleRequestFailed({ cause }))),
  );

const isOk = (response: BufferedResponse) => response.status >= 200 && response.status < 300;

const persistVisit = (visit: Visit) =>
  Schema.encodeEffect(RecordedReadsJson)(visit.reads).pipe(
    Effect.flatMap((json) =>
      Effect.try(() => globalThis.localStorage.setItem(`${MANIFEST_PREFIX}${visit.pathname}`, json)),
    ),
    Effect.ignore,
  );

const recordRead = Effect.fn('BrowserRequestCache.recordRead')(function* recordReadEffect(
  state: CacheState,
  read: ModuleRead,
  now: number,
) {
  // The bridge omits the native preload flag. Conservatively omit overlapping foreground reads too.
  // This counter is never consulted by preparation scheduling, request authority or cache identity.
  if (MutableRef.get(preparations) > 0) {
    return;
  }
  const { pathname } = globalThis.location;
  const visit: Visit = state.visit?.pathname === pathname ? state.visit : { pathname, reads: [], startedAt: now };
  state.visit = visit;
  const { audience } = read;
  if (
    audience === undefined ||
    now - visit.startedAt > VISIT_RECORD_MILLIS ||
    visit.reads.length >= RECORDED_READS_LIMIT ||
    visit.reads.some((recorded) => readKey(recorded) === readKey(read))
  ) {
    return;
  }
  visit.reads.push({
    audience,
    body: read.body,
    compositionRevision: read.compositionRevision,
    contentType: read.contentType,
    url: read.url,
  });
  yield* persistVisit(visit);
});

const startRead = Effect.fn('BrowserRequestCache.startRead')(function* startReadEffect(
  state: CacheState,
  read: ModuleRead,
  now: number,
) {
  const key = readKey(read);
  const { generation } = state;
  const keep = now >= state.quietUntil;
  const fiber = yield* Effect.forkDetach(bufferedFetch(state, read.url, read.init));
  const entry: ReadEntry = { fiber, primary: MutableRef.get(preparations) === 0, startedAt: now };
  if (state.reads.size >= READ_ENTRY_LIMIT) {
    state.reads.clear();
  }
  state.reads.set(key, entry);
  // Concurrent callers share the request while it runs; only a successful answer that no write overtook stays.
  yield* Effect.forkDetach(
    Fiber.await(fiber).pipe(
      Effect.tap((exit) =>
        Effect.sync(() => {
          const kept = keep && state.generation === generation && Exit.isSuccess(exit) && isOk(exit.value);
          if (!kept && state.reads.get(key) === entry) {
            state.reads.delete(key);
          }
        }),
      ),
    ),
  );
  return entry;
});

const serveRead = Effect.fn('BrowserRequestCache.serveRead')(function* serveReadEffect(
  state: CacheState,
  read: ModuleRead,
  record: boolean,
): Effect.fn.Return<BufferedResponse, ModuleRequestFailed> {
  const now = yield* Clock.currentTimeMillis;
  if (record) {
    yield* recordRead(state, read, now);
  }
  const { contextGeneration, generation } = state;
  const entry = state.reads.get(readKey(read));
  if (entry !== undefined && (entry.fiber.pollUnsafe() === undefined || now - entry.startedAt < READ_FRESH_MILLIS)) {
    const exit = yield* Fiber.await(entry.fiber);
    if (state.contextGeneration !== contextGeneration) {
      return yield* new ModuleRequestFailed();
    }
    if (state.generation !== generation) {
      return yield* serveRead(state, read, false);
    }
    if (Exit.isSuccess(exit)) {
      return exit.value;
    }
  }
  const started = yield* startRead(state, read, now);
  const response = yield* Fiber.join(started.fiber);
  if (state.contextGeneration !== contextGeneration) {
    return yield* new ModuleRequestFailed();
  }
  return state.generation === generation ? response : yield* serveRead(state, read, false);
});

const assertionUsable = (response: BufferedResponse, now: number) =>
  isOk(response)
    ? Schema.decodeEffect(GatewayResponseJson)(textDecoder.decode(response.body)).pipe(
        Effect.map(({ expiresAt }) => expiresAt * 1000 - now > ASSERTION_REUSE_MARGIN_MILLIS),
        Effect.orElseSucceed(() => false),
      )
    : Effect.succeed(false);

const rememberAudience = (state: CacheState, requestBody: string, response: BufferedResponse) =>
  Effect.all(
    [
      Schema.decodeEffect(GatewayRequestJson)(requestBody),
      Schema.decodeEffect(GatewayResponseJson)(textDecoder.decode(response.body)),
    ],
    { concurrency: 1 },
  ).pipe(
    Effect.tap(([{ audience }, { token }]) => Effect.sync(() => state.audiences.set(token, audience))),
    Effect.ignore,
  );

/**
 * A request for the document session's assertion (no other legal entity named) is answered from the document's
 * assertions when it holds one for that audience and revision (see document-gateway-assertions.ts).
 */
const documentGatewayAnswer = (state: CacheState, requestBody: string) =>
  Schema.decodeEffect(DocumentGatewayRequestJson)(requestBody).pipe(
    Effect.flatMap(({ audience, compositionRevision, legalEntityId }) =>
      legalEntityId === undefined
        ? documentGatewayAssertion(audience, compositionRevision).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.succeedNone,
                onSome: (assertion) =>
                  Schema.encodeEffect(GatewayAssertionJson)(assertion).pipe(
                    Effect.map((json) => {
                      state.audiences.set(assertion.token, audience);
                      const body = textEncoder.encode(json);
                      return Option.some<BufferedResponse>({
                        body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
                        headers: { 'cache-control': 'no-store', 'content-type': 'application/json' },
                        status: 200,
                        statusText: 'OK',
                      });
                    }),
                  ),
              }),
            ),
          )
        : Effect.succeedNone,
    ),
    Effect.orElseSucceed(() => Option.none<BufferedResponse>()),
  );

/** An audience answered by the single issuer joins the document's set, so the next renewal batches it too. */
const noteSingleAudience = (requestBody: string) =>
  Schema.decodeEffect(DocumentGatewayRequestJson)(requestBody).pipe(
    Effect.flatMap(({ audience, compositionRevision, legalEntityId }) =>
      legalEntityId === undefined ? noteDocumentGatewayAudience(audience, compositionRevision) : Effect.void,
    ),
    Effect.ignore,
  );

const serveGateway = Effect.fn('BrowserRequestCache.serveGateway')(function* serveGatewayEffect(
  state: CacheState,
  request: Extract<ClassifiedRequest, { kind: 'gateway' }>,
) {
  const { contextGeneration } = state;
  const documentAnswer = yield* documentGatewayAnswer(state, request.body);
  if (state.contextGeneration !== contextGeneration) {
    return yield* new ModuleRequestFailed();
  }
  if (Option.isSome(documentAnswer)) {
    return documentAnswer.value;
  }
  const now = yield* Clock.currentTimeMillis;
  const shared = state.assertions.get(request.body);
  if (shared !== undefined) {
    const exit = yield* Fiber.await(shared);
    if (state.contextGeneration !== contextGeneration) {
      return yield* new ModuleRequestFailed();
    }
    if (Exit.isSuccess(exit) && (yield* assertionUsable(exit.value, now))) {
      return exit.value;
    }
  }
  const fiber = yield* Effect.forkDetach(bufferedFetch(state, request.url, request.init));
  state.assertions.set(request.body, fiber);
  const exit = yield* Fiber.await(fiber);
  if (state.contextGeneration !== contextGeneration) {
    return yield* new ModuleRequestFailed();
  }
  if (Exit.isSuccess(exit) && isOk(exit.value)) {
    yield* rememberAudience(state, request.body, exit.value);
    yield* noteSingleAudience(request.body);
  } else if (state.assertions.get(request.body) === fiber) {
    state.assertions.delete(request.body);
  }
  return yield* exit;
});

const serveWrite = (state: CacheState, input: RequestInfo | URL, init: RequestInit | undefined) =>
  Effect.tryPromise({
    catch: (cause) => new ModuleRequestFailed({ cause }),
    try: async () => await state.original(input, init),
  }).pipe(
    Effect.timeout('2 minutes'),
    Effect.catchTag('TimeoutError', (cause) => Effect.fail(new ModuleRequestFailed({ cause }))),
    Effect.onExit((exit) =>
      // A rejected command (4xx) changed nothing; anything else may have, including a lost connection.
      Exit.isSuccess(exit) && exit.value.status >= 400 && exit.value.status < 500
        ? Effect.void
        : Clock.currentTimeMillis.pipe(
            Effect.tap((now) =>
              Effect.sync(() => {
                state.reads.clear();
                state.generation += 1;
                state.quietUntil = now + WRITE_QUIET_MILLIS;
                // Page-data stores in every remote mark their values stale and revalidate what is on screen.
                globalThis.dispatchEvent(new Event(moduleWriteEvent));
              }),
            ),
          ),
    ),
  );

/** The Shell installs the cache once per document; prefetches read the same state. */
const installed = MutableRef.make(Option.none<CacheState>());

/** Cold foreground preparation owns priority even before its remote code can issue any reads. */
const primaryPreparations = MutableRef.make(new Map<string, Set<Deferred.Deferred<boolean>>>());

export const withPrimaryModulePreparation = <A, E, R>(pathname: string, work: Effect.Effect<A, E, R>) =>
  Effect.suspend(() =>
    pathname === globalThis.location.pathname
      ? Effect.acquireUseRelease(
          Deferred.make<boolean>().pipe(
            Effect.tap((settled) =>
              Effect.sync(() => {
                const preparing = MutableRef.get(primaryPreparations);
                const active = preparing.get(pathname) ?? new Set<Deferred.Deferred<boolean>>();
                active.add(settled);
                preparing.set(pathname, active);
              }),
            ),
          ),
          () => work,
          (settled) =>
            Effect.sync(() => {
              const preparing = MutableRef.get(primaryPreparations);
              const active = preparing.get(pathname);
              active?.delete(settled);
              if (active?.size === 0) {
                preparing.delete(pathname);
              }
            }).pipe(Effect.andThen(Deferred.succeed(settled, true))),
        )
      : work,
  );

/** Wait for foreground preparation first; an empty request cache alone does not mean the page is ready. */
export const awaitPrimaryModuleReads = Effect.gen(function* awaitCurrentPagePrimaryReads() {
  const preparing = [...(MutableRef.get(primaryPreparations).get(globalThis.location.pathname) ?? [])];
  yield* Effect.forEach(preparing, Deferred.await, { concurrency: READ_ENTRY_LIMIT, discard: true });
  const current = MutableRef.get(installed);
  if (Option.isSome(current)) {
    // Snapshot only foreground reads. Later speculative destinations never extend this gate.
    yield* Effect.forEach(
      [...current.value.reads.values()].filter(({ primary }) => primary),
      ({ fiber }) => Fiber.await(fiber),
      { concurrency: READ_ENTRY_LIMIT, discard: true },
    ).pipe(
      Effect.timeout(BACKGROUND_WAIT_LIMIT),
      // Primary reads have already been issued; an expired wait must not quarantine all destinations.
      Effect.ignore,
    );
  }
  return true;
});

/** A context boundary invalidates pending answers as well as completed data and gateway assertions. */
export const clearBrowserRequestCache = Effect.sync(() => {
  const current = MutableRef.get(installed);
  if (Option.isSome(current)) {
    const state = current.value;
    state.generation += 1;
    state.contextGeneration += 1;
    state.quietUntil = 0;
    state.reads.clear();
    state.assertions.clear();
    state.audiences.clear();
    delete state.visit;
  }
}).pipe(Effect.andThen(resetDocumentGatewayAssertions), Effect.asVoid);

/**
 * Wraps the document's `fetch` once, before any remote loads. Requests other than module reads, module writes and
 * gateway assertions go straight to the original `fetch`. A caller's abort signal cancels only its own wait, never
 * a request another caller shares.
 */
export const installBrowserRequestCache = (): void => {
  if (Option.isSome(MutableRef.get(installed))) {
    return;
  }
  const state: CacheState = {
    assertions: new Map(),
    audiences: new Map(),
    contextGeneration: 0,
    generation: 0,
    original: globalThis.fetch.bind(globalThis),
    quietUntil: 0,
    reads: new Map(),
  };
  MutableRef.set(installed, Option.some(state));
  // Page-data announces the real lifetime across separately bundled remotes. Overlapping foreground work
  // is conservatively excluded too, just as it is while a declared preparation's Promise is pending.
  globalThis.addEventListener(pageDataWorkEvent, (event) => {
    if (MutableRef.get(preparations) > 0) {
      retainPageDataWork(event.detail);
    }
  });
  // eslint-disable-next-line effect-native/no-promise-shaped-port -- This replaces the platform `fetch`, whose contract is a Promise. expires: 2027-03-31.
  const wrapped: typeof globalThis.fetch = async (input, init) => {
    const handled = Match.value(classify(state, input, init)).pipe(
      Match.discriminatorsExhaustive('kind')({
        gateway: (request) => Option.some(serveGateway(state, request).pipe(Effect.map(toResponse))),
        pass: () => Option.none(),
        read: ({ read }) => Option.some(serveRead(state, read, true).pipe(Effect.map(toResponse))),
        write: () => Option.some(serveWrite(state, input, init)),
      }),
    );
    return Option.isSome(handled)
      ? await browserRuntime.runPromise(handled.value, { signal: init?.signal ?? undefined })
      : await state.original(input, init);
  };
  Object.defineProperty(globalThis, 'fetch', { configurable: true, enumerable: true, value: wrapped, writable: true });
};

const readManifest = (pathname: string) =>
  Effect.try(() => globalThis.localStorage.getItem(`${MANIFEST_PREFIX}${pathname}`)).pipe(
    Effect.flatMap((json) =>
      json === null ? Effect.succeed<readonly RecordedRead[]>([]) : Schema.decodeEffect(RecordedReadsJson)(json),
    ),
    Effect.orElseSucceed((): readonly RecordedRead[] => []),
  );

const prefetchRead = (state: CacheState, read: RecordedRead) =>
  makeOperationGateway(read.audience)
    .invoke((authorization, { compositionRevision }) =>
      serveRead(
        state,
        {
          audience: read.audience,
          body: read.body,
          compositionRevision,
          contentType: read.contentType,
          init: {
            body: read.body,
            headers: {
              authorization,
              'content-type': read.contentType,
              'x-correlation-id': `prefetch:${read.audience}`,
              'x-ontos-composition-revision': compositionRevision,
            },
            method: 'POST',
          },
          url: read.url,
        },
        false,
      ),
    )
    .pipe(Effect.ignore);

/**
 * Issues the reads this path made the last time it opened, so its page finds them answered. Each read gets a fresh
 * assertion for its own audience; reads recorded under another composition revision are skipped.
 */
export const prefetchRecordedReads = Effect.fn('BrowserRequestCache.prefetchRecordedReads')(
  function* prefetchRecordedReadsEffect(pathname: string) {
    const current = MutableRef.get(installed);
    if (Option.isNone(current)) {
      return;
    }
    const state = current.value;
    const [reads, revision] = yield* Effect.all(
      [readManifest(pathname), getDocumentCompositionRevision().pipe(Effect.option)],
      { concurrency: 2 },
    );
    if (Option.isNone(revision)) {
      return;
    }
    yield* Effect.forEach(
      // A read recorded without a revision header still names its module release in the URL.
      reads.filter((read) => read.compositionRevision === '' || read.compositionRevision === revision.value),
      (read) => prefetchRead(state, read),
      { concurrency: PREFETCH_CONCURRENCY, discard: true },
    );
  },
);

/**
 * Drops every recorded page read. Recordings belong to the account that made them, so signing in or out must not
 * let the next account replay reads (and warm assertions) it may not be allowed to make.
 */
export const forgetRecordedPageReads = clearBrowserRequestCache.pipe(
  Effect.andThen(
    Effect.try(() => {
      for (const key of Object.keys(globalThis.localStorage)) {
        if (key.startsWith(MANIFEST_PREFIX)) {
          globalThis.localStorage.removeItem(key);
        }
      }
    }),
  ),
  Effect.ignore,
);
