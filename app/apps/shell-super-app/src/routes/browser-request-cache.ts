// @effect-diagnostics asyncFunction:off -- Browser fetch transport boundary: the wrapper implements `typeof fetch`, whose contract is a Promise; cache logic stays in Effect. expires: 2027-03-31.
import { getDocumentCompositionRevision, makeOperationGateway } from '@app/shared-contracts';
import { Clock, Effect, Exit, Fiber, Match, MutableRef, Option, Predicate, Schedule, Schema } from 'effect';

import { browserRuntime } from '../runtime/browser-effect-runtime.ts';

/**
 * One in-memory cache per document for the browser's module traffic, installed by the Shell around `fetch`.
 *
 * Every remote bundles its own copy of the generated clients, so a cache inside those clients would be one cache
 * per remote. `fetch` is the seam they all share: module reads (`/module-api/…/reads/…` and `…/search/…`) are
 * answered from memory, concurrent identical reads share one request, and gateway assertions are reused across
 * remotes until shortly before they expire. Any other module request is a write: once it settles, every cached
 * read is dropped, so a user never sees their own change missing.
 *
 * The reads a page makes right after it opens are remembered per path (in `localStorage`, without credentials), so
 * a later preload of that path can issue them before the click.
 */

/** A read this young is served without asking the module again. */
const READ_FRESH_MILLIS = 20_000;
/** Up to this age a read is still served at once and refreshed in the background for the next visit. */
const READ_STALE_MILLIS = 120_000;
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
/** Module traffic counts as quiet once nothing has been in flight for this long. */
const TRAFFIC_QUIET_MILLIS = 1000;
/** Speculative work waits at most this long for a busy page to go quiet. */
const TRAFFIC_QUIET_WAIT_LIMIT = '30 seconds';

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
  /** Bumped by every settled write; a read that started before it is never kept. */
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

// The shared request runs detached from any one caller, so it must not carry that caller's abort signal.
const bufferedFetch = (state: CacheState, url: string, { signal: _callerSignal, ...init }: RequestInit) =>
  Effect.tryPromise({
    catch: (cause) => new ModuleRequestFailed({ cause }),
    try: async () => {
      const response = await state.original(url, init);
      return {
        body: await response.arrayBuffer(),
        headers: Object.fromEntries(response.headers),
        status: response.status,
        statusText: response.statusText,
      } satisfies BufferedResponse;
    },
  }).pipe(
    Effect.timeout('30 seconds'),
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
  const entry: ReadEntry = { fiber, startedAt: now };
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
) {
  const now = yield* Clock.currentTimeMillis;
  if (record) {
    yield* recordRead(state, read, now);
  }
  const entry = state.reads.get(readKey(read));
  if (entry !== undefined && now - entry.startedAt < READ_STALE_MILLIS) {
    const exit = yield* Fiber.await(entry.fiber);
    if (Exit.isSuccess(exit)) {
      if (now - entry.startedAt >= READ_FRESH_MILLIS && state.reads.get(readKey(read)) === entry) {
        yield* startRead(state, read, now);
      }
      return exit.value;
    }
  }
  const started = yield* startRead(state, read, now);
  return yield* Fiber.join(started.fiber);
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

const serveGateway = Effect.fn('BrowserRequestCache.serveGateway')(function* serveGatewayEffect(
  state: CacheState,
  request: Extract<ClassifiedRequest, { kind: 'gateway' }>,
) {
  const now = yield* Clock.currentTimeMillis;
  const shared = state.assertions.get(request.body);
  if (shared !== undefined) {
    const exit = yield* Fiber.await(shared);
    if (Exit.isSuccess(exit) && (yield* assertionUsable(exit.value, now))) {
      return exit.value;
    }
  }
  const fiber = yield* Effect.forkDetach(bufferedFetch(state, request.url, request.init));
  state.assertions.set(request.body, fiber);
  const exit = yield* Fiber.await(fiber);
  if (Exit.isSuccess(exit) && isOk(exit.value)) {
    yield* rememberAudience(state, request.body, exit.value);
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
              }),
            ),
          ),
    ),
  );

/** The Shell installs the cache once per document; prefetches read the same state. */
const installed = MutableRef.make(Option.none<CacheState>());

/** Module requests (reads, writes, gateway assertions) in flight in this document, and when the last one settled. */
const traffic = MutableRef.make({ inFlight: 0, settledAt: 0 });

const tracked = <A, E>(request: Effect.Effect<A, E>) =>
  Effect.sync(() =>
    MutableRef.update(traffic, ({ inFlight, settledAt }) => ({ inFlight: inFlight + 1, settledAt })),
  ).pipe(
    Effect.andThen(request),
    Effect.ensuring(
      Clock.currentTimeMillis.pipe(
        Effect.tap((now) =>
          Effect.sync(() => MutableRef.update(traffic, ({ inFlight }) => ({ inFlight: inFlight - 1, settledAt: now }))),
        ),
      ),
    ),
  );

const trafficQuiet = Clock.currentTimeMillis.pipe(
  Effect.map((now) => {
    const { inFlight, settledAt } = MutableRef.get(traffic);
    return inFlight === 0 && now - settledAt >= TRAFFIC_QUIET_MILLIS;
  }),
);

/**
 * Waits until the document's module traffic has been quiet for a second (at most 30 s), so speculative warming never
 * competes with the reads of the page the person is looking at. On a slow backend those reads can take seconds.
 */
export const awaitModuleTrafficQuiet = trafficQuiet.pipe(
  Effect.repeat({ schedule: Schedule.spaced('250 millis'), until: (quiet) => quiet }),
  Effect.timeout(TRAFFIC_QUIET_WAIT_LIMIT),
  Effect.ignore,
);

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
    generation: 0,
    original: globalThis.fetch.bind(globalThis),
    quietUntil: 0,
    reads: new Map(),
  };
  MutableRef.set(installed, Option.some(state));
  // eslint-disable-next-line effect-native/no-promise-shaped-port -- This replaces the platform `fetch`, whose contract is a Promise. expires: 2027-03-31.
  const wrapped: typeof globalThis.fetch = async (input, init) => {
    const handled = Match.value(classify(state, input, init)).pipe(
      Match.discriminatorsExhaustive('kind')({
        gateway: (request) => Option.some(tracked(serveGateway(state, request)).pipe(Effect.map(toResponse))),
        pass: () => Option.none(),
        read: ({ read }) => Option.some(tracked(serveRead(state, read, true)).pipe(Effect.map(toResponse))),
        write: () => Option.some(tracked(serveWrite(state, input, init))),
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
      tracked(
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
export const forgetRecordedPageReads = Effect.try(() => {
  for (const key of Object.keys(globalThis.localStorage)) {
    if (key.startsWith(MANIFEST_PREFIX)) {
      globalThis.localStorage.removeItem(key);
    }
  }
}).pipe(Effect.ignore);
