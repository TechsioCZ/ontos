// One post-deploy verification pass of stage (no load: the stage Workers CPU budget is capped).
// Signs in as a persona, times three authenticated /cs documents, checks the OAuth metadata and the
// AKROS storefront home, then signs the session out through the native action even when a check
// failed. Each page document must answer within DOCUMENT_ACCEPTANCE_MS; OAuth metadata and the auth
// writes are checked for status only, because the page budget is not their contract.
// usage: node scripts/ops/stage-demo-verify.mjs
import { NodeRuntime } from '@effect/platform-node';
import { Clock, Config, Console, Data, Duration, Effect, Redacted, Ref, Schema } from 'effect';

import { SignInPayloadSchema } from '../../apps/shell-super-app/shared/api.ts';

const DEFAULT_SHELL_URL = 'https://ontos-stage.bleeding.dev';
const DEFAULT_STOREFRONT_URL = 'https://ontos-stage-akros.bleeding.dev';
const DEFAULT_PERSONA = 'management@najempark.demo';
export const DEFAULT_PASSWORD = Redacted.make('password1234');
const REQUEST_TIMEOUT_MS = 60_000;
const SIGN_OUT_TIMEOUT_MS = 10_000;

/** Page acceptance for a document response. Deliberately has no environment or flag override. */
export const DOCUMENT_ACCEPTANCE_MS = 1500;

/** A request or body read failed at the private fetch adapter. */
export const StageTransportError = Data.TaggedError('StageTransportError');

/** A typed probe failure retained in the verification report. */
export class StageVerificationFailure extends Data.TaggedError('StageVerificationFailure') {
  /**
   * @param {string} label The probe that failed.
   * @param {'transport' | 'body' | 'status' | 'budget' | 'session' | 'timeout' | 'payload' | 'summary'} reason The failed contract.
   * @param {string} message The operator-facing failure description.
   */
  constructor(label, reason, message) {
    super({ message });
    this.label = label;
    this.reason = reason;
  }
}

/**
 * @typedef {{
 *   status: number,
 *   headers: Headers,
 *   body: Effect.Effect<void, InstanceType<typeof StageTransportError>>
 * }} StageResponse
 */

/**
 * @typedef {(url: string, init: RequestInit) => Effect.Effect<StageResponse, InstanceType<typeof StageTransportError>>} StageTransport
 */

/**
 * Native Promises remain inside this private HTTP edge. The probe owns the abort signal and scope
 * for both receiving headers and consuming the body.
 * @type {StageTransport}
 */
const fetchTransport = (url, init) =>
  Effect.tryPromise({
    catch: (cause) => new StageTransportError({ message: String(cause) }),
    try: fetch.bind(globalThis, url, init),
  }).pipe(
    Effect.map((response) => ({
      body: Effect.tryPromise({
        catch: (cause) => new StageTransportError({ message: String(cause) }),
        try: response.arrayBuffer.bind(response),
      }).pipe(Effect.asVoid),
      headers: response.headers,
      status: response.status,
    })),
  );

/** @param {StageResponse} response The session cookies whose lifetime this pass owns. */
const sessionCookie = (response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');

/** @param {bigint} started The monotonic clock reading at the start of a probe. */
const elapsedMillis = (started) =>
  Clock.monotonicTimeNanos.pipe(Effect.map((now) => Duration.toMillis(Duration.nanos(now - started))));

/** @param {StageVerificationFailure[]} failures The pass-local report. */
const recordInto = (failures) => {
  /** @param {StageVerificationFailure} failure A typed failure to retain. */
  const recordFailure = (failure) =>
    Effect.sync(() => {
      failures.push(failure);
    });
  return recordFailure;
};

/** @param {string} label The request whose transport failed. */
const transportFailure =
  (label) =>
  /** @param {InstanceType<typeof StageTransportError>} error The private transport diagnostic. */
  (error) =>
    new StageVerificationFailure(label, 'transport', `${label} failed: ${error.message}`);

/** @param {AbortController} controller The probe's request and body lifetime. */
const abortRequest = (controller) => Effect.sync(() => controller.abort());

/**
 * @param {StageTransport} transport The Effect-shaped HTTP port.
 * @param {StageVerificationFailure[]} failures The pass-local report.
 */
const makeProbe = (transport, failures) => {
  const recordFailure = recordInto(failures);
  /**
   * @param {string} label The probe label.
   * @param {string} url The absolute endpoint.
   * @param {{budgetMs?: number, init?: RequestInit, onResponse?: (response: StageResponse) => Effect.Effect<void>, timeoutMs?: number}} [options] Probe policy.
   */
  const probe = (label, url, { budgetMs, init, onResponse = () => Effect.void, timeoutMs = REQUEST_TIMEOUT_MS } = {}) =>
    Effect.scoped(
      Effect.gen(function* probeDocument() {
        const started = yield* Clock.monotonicTimeNanos;
        const controller = yield* Effect.acquireRelease(
          Effect.sync(() => new AbortController()),
          abortRequest,
        );
        // Register an issued session before body consumption can fail or be interrupted.
        const response = yield* Effect.uninterruptibleMask((restore) =>
          restore(
            transport(url, { ...init, redirect: 'manual', signal: controller.signal }).pipe(
              Effect.mapError(transportFailure(label)),
            ),
          ).pipe(Effect.tap(onResponse)),
        );
        const elapsed = yield* elapsedMillis(started);
        yield* response.body.pipe(
          Effect.catchTag('StageTransportError', (error) =>
            recordFailure(new StageVerificationFailure(label, 'body', `${label} body failed: ${error.message}`)),
          ),
        );
        const total = yield* elapsedMillis(started);
        yield* Console.log(
          `${label} ${response.status} ttfb=${(elapsed / 1000).toFixed(2)}s total=${(total / 1000).toFixed(2)}s`,
        );
        if (response.status !== 200) {
          yield* recordFailure(new StageVerificationFailure(label, 'status', `${label} answered ${response.status}`));
        } else if (budgetMs !== undefined && total > budgetMs) {
          yield* recordFailure(
            new StageVerificationFailure(
              label,
              'budget',
              `${label} took ${Math.round(total)}ms, over the ${budgetMs}ms page budget`,
            ),
          );
        }
      }),
    ).pipe(
      // Resource finalizers are masked; the timed child must still be interruptible at its deadline.
      Effect.interruptible,
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () =>
          Effect.fail(new StageVerificationFailure(label, 'timeout', `${label} timed out after ${timeoutMs}ms`)),
      }),
      Effect.catchTag('StageVerificationFailure', recordFailure),
    );
  return probe;
};

/**
 * @param {ReturnType<typeof makeProbe>} probe The pass-local probe.
 * @param {string} shellUrl The Shell origin that issued the session.
 */
const signOutSession =
  (probe, shellUrl) =>
  /** @param {Ref.Ref<string>} session The session issued to this verification pass. */
  (session) =>
    Ref.get(session).pipe(
      Effect.flatMap((cookie) =>
        cookie === ''
          ? Effect.void
          : probe('sign-out', `${shellUrl}/shell-super-app-api/auth/sign-out`, {
              init: { headers: { cookie, origin: shellUrl }, method: 'POST' },
              timeoutMs: SIGN_OUT_TIMEOUT_MS,
            }),
      ),
    );

/**
 * @param {Ref.Ref<string>} session The session issued to this verification pass.
 * @param {ReturnType<typeof recordInto>} recordFailure The pass-local report sink.
 */
const receiveSession =
  (session, recordFailure) =>
  /** @param {StageResponse} response The sign-in headers, before body consumption. */
  (response) => {
    const cookie = sessionCookie(response);
    return Ref.set(session, cookie).pipe(
      Effect.andThen(
        cookie === ''
          ? recordFailure(
              new StageVerificationFailure('sign-in', 'session', 'sign-in answered without a session cookie'),
            )
          : Effect.void,
      ),
    );
  };

/**
 * Runs one sequential verification pass and retains typed failures without skipping later probes.
 * Clock and Console come from Effect services; tests replace only the Effect-shaped HTTP port.
 * @param {object} [options] The pass configuration.
 * @param {Redacted.Redacted} [options.password] The persona's password.
 * @param {string} [options.persona] The account the pass signs in with.
 * @param {string} [options.shellUrl] The Shell origin.
 * @param {string} [options.storefrontUrl] The storefront origin.
 * @param {StageTransport} [options.transport] The HTTP transport.
 * @returns {Effect.Effect<{failures: StageVerificationFailure[]}>} Failures in probe order, including finalization.
 */
export const verifyStage = ({
  password = DEFAULT_PASSWORD,
  persona = DEFAULT_PERSONA,
  shellUrl = DEFAULT_SHELL_URL,
  storefrontUrl = DEFAULT_STOREFRONT_URL,
  transport = fetchTransport,
} = {}) =>
  Effect.suspend(() => {
    /** @type {StageVerificationFailure[]} */
    const failures = [];
    const recordFailure = recordInto(failures);
    const probe = makeProbe(transport, failures);
    const pass = Effect.gen(function* verifyOwnedSession() {
      yield* Effect.forEach(
        ['oauth-authorization-server', 'oauth-protected-resource'],
        (label) => probe(label, `${shellUrl}/.well-known/${label}`),
        { concurrency: 1, discard: true },
      );
      const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.toCodecJson(SignInPayloadSchema)))({
        email: persona,
        password,
      }).pipe(
        Effect.mapError(
          () => new StageVerificationFailure('sign-in', 'payload', 'sign-in payload did not match the Shell contract'),
        ),
      );
      const session = yield* Effect.acquireRelease(Ref.make(''), signOutSession(probe, shellUrl));
      yield* probe('sign-in', `${shellUrl}/shell-super-app-api/auth/sign-in`, {
        init: {
          body,
          headers: { 'content-type': 'application/json', origin: shellUrl },
          method: 'POST',
        },
        onResponse: receiveSession(session, recordFailure),
      });
      const cookie = yield* Ref.get(session);
      if (cookie !== '') {
        yield* Effect.forEach(
          [1, 2, 3],
          (attempt) =>
            probe(`/cs #${attempt} (${persona})`, `${shellUrl}/cs`, {
              budgetMs: DOCUMENT_ACCEPTANCE_MS,
              init: { headers: { cookie } },
            }),
          { concurrency: 1, discard: true },
        );
      }
      yield* probe('storefront home', `${storefrontUrl}/`, { budgetMs: DOCUMENT_ACCEPTANCE_MS });
    });
    return Effect.scoped(pass).pipe(
      Effect.catchTag('StageVerificationFailure', recordFailure),
      Effect.as({ failures }),
    );
  });

/** @param {StageTransport} [transport] The private transport replaced only by tests. */
export const verifyStageFromConfig = (transport = fetchTransport) =>
  Effect.gen(function* verifyStageCommand() {
    const settings = yield* Config.all({
      persona: Config.String('STAGE_VERIFY_PERSONA').pipe(Config.withDefault(DEFAULT_PERSONA)),
      shellUrl: Config.String('STAGE_SHELL_URL').pipe(Config.withDefault(DEFAULT_SHELL_URL)),
      storefrontUrl: Config.String('STAGE_STOREFRONT_URL').pipe(Config.withDefault(DEFAULT_STOREFRONT_URL)),
    });
    const { failures } = yield* verifyStage({ ...settings, transport });
    if (failures.length > 0) {
      yield* Effect.fail(
        new StageVerificationFailure(
          'stage verification',
          'summary',
          `stage verification FAILED: ${failures.map((failure) => failure.message).join('; ')}`,
        ),
      );
    }
    yield* Console.log('stage verification PASS');
  }).pipe(Effect.tapError((failure) => Console.error(failure.message)));

if (import.meta.main) {
  NodeRuntime.runMain(verifyStageFromConfig(), { disableErrorReporting: true });
}
