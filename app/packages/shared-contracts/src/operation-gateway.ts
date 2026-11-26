import { Effect, Redacted, Schema } from 'effect';
import { ReferenceGatewayCredentialsSchema } from './reference-gateway.ts';

import {
  DocumentCompositionRevisionError,
  adoptCompositionRevision,
  getDocumentCompositionRevision,
} from './document-composition-revision.ts';
import { isDocumentAppDenied } from './document-denied-apps.ts';
import { GatewayContextResponseSchema, GatewayForbiddenProblemSchema, issueGatewayContext } from './gateway-context.ts';
import type {
  GatewayContextClientError,
  GatewayContextClientOptions,
  GatewayContextResponse,
} from './gateway-context.ts';

export type OperationGatewayIssuer<Audience extends string, Failure> = (
  payload: { readonly audience: Audience; readonly compositionRevision: string },
  options?: GatewayContextClientOptions,
) => Effect.Effect<GatewayContextResponse, Failure>;

export type OperationGatewayAttempt<Success, Failure> = (
  authorizationHeader: string,
  target: Pick<GatewayContextResponse, 'apiBaseUrl' | 'compositionRevision'>,
) => Effect.Effect<Success, Failure>;

// eslint-disable-next-line effect-native/require-context-service-for-service-interface -- This browser gateway is an audience-bound value, not an injectable application service. expires: 2027-03-31.
export interface OperationGateway<IssuerFailure> {
  readonly invoke: <Success, AttemptFailure>(
    attempt: OperationGatewayAttempt<Success, AttemptFailure>,
    options?: GatewayContextClientOptions,
  ) => Effect.Effect<Success, IssuerFailure | AttemptFailure | DocumentCompositionRevisionError | Schema.SchemaError>;
}

const deniedAudienceProblem = GatewayForbiddenProblemSchema.make({
  detail: 'The authenticated principal cannot open this module in the current company.',
  status: GatewayForbiddenProblemSchema.fields.status.literal,
  title: 'Gateway context forbidden',
  type: 'https://ontos.dev/problems/gateway-forbidden',
});

/**
 * The document session's issuer. An audience the shell's composition found definitely denied fails as the issuer's
 * own GatewayForbiddenProblem without a request (see document-denied-apps.ts); modules still authorize every call.
 */
const skippingDeniedAudiences =
  (
    issuer: OperationGatewayIssuer<string, GatewayContextClientError>,
  ): OperationGatewayIssuer<string, GatewayContextClientError> =>
  (payload, options = {}) =>
    Effect.suspend(() =>
      options.baseUrl === undefined && options.cookie === undefined && isDocumentAppDenied(payload.audience)
        ? Effect.fail(deniedAudienceProblem)
        : issuer(payload, options),
    );

const browserGatewayContextIssuer = skippingDeniedAudiences(issueGatewayContext);

const fieldOf = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null && key in value ? Reflect.get(value, key) : undefined;

const httpStatusOf = (error: unknown): unknown => fieldOf(fieldOf(error, 'response'), 'status');

/**
 * A deploy switched the release this document was opened with: the Shell refuses an assertion for the old revision,
 * or the module API refuses the old revision or module build with a plain 409.
 */
const releaseChanged = (error: unknown): boolean => {
  const tag = fieldOf(error, '_tag');
  if (tag === 'GatewayReloadRequiredProblem') {
    return true;
  }
  if (tag === 'DocumentCompositionRevisionError') {
    return fieldOf(error, 'reason') === 'revision-mismatch';
  }
  if (tag === 'HttpClientError') {
    const url = fieldOf(fieldOf(error, 'request'), 'url');
    return httpStatusOf(error) === 409 && typeof url === 'string' && url.includes('/module-api/');
  }
  return false;
};

/** Short outages while a deploy switches instances (the owner's permission check, the Shell issuer). */
const transientlyUnavailable = (error: unknown): boolean =>
  fieldOf(error, 'code') === 'action_permission_check_failed' ||
  fieldOf(error, '_tag') === 'GatewayUnavailableProblem' ||
  fieldOf(error, 'status') === 503 ||
  httpStatusOf(error) === 503 ||
  httpStatusOf(error) === 502;

const revisionMetaPattern = /<meta\b[^>]*\bname="ontos-composition-revision"[^>]*>/u;
const revisionContentPattern = /\bcontent="([\da-f]{64})"/u;

/** The release the Shell serves now, read from a fresh render of this page (the document's own pin stays sealed). */
// @effect-diagnostics-next-line asyncFunction:off -- Hotfix: the stage build fails on this diagnostic; expires: 2026-12-31.
const currentReleaseRevision = Effect.tryPromise(async () => {
  // @effect-diagnostics-next-line globalFetchInEffect:off -- Hotfix: a same-page document read; expires: 2026-12-31.
  const response = await globalThis.fetch(globalThis.location.href, {
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { accept: 'text/html' },
  });
  const html = response.ok ? await response.text() : '';
  const tag = revisionMetaPattern.exec(html)?.[0];
  return tag === undefined ? undefined : revisionContentPattern.exec(tag)?.[1];
}).pipe(
  Effect.timeout('15 seconds'),
  Effect.orElseSucceed((): string | undefined => undefined),
);

/** Attempts of one call across a deploy: the release switch takes about a minute on stage. */
const RECOVERY_ROUNDS = 6;
const recoveryDelayMillis = (round: number) => (round === 0 ? 0 : 1500 * round);

/**
 * Runs `once` and, when a deploy got in the way, adopts the new release and runs it again with the same inputs (the
 * caller's idempotency key included), so an open editor saves without a reload. Other failures pass through.
 */
const recoveringAcrossDeploys = <Success, Failure>(once: Effect.Effect<Success, Failure>) => {
  const recover = (error: Failure, round: number): Effect.Effect<Success, Failure> => {
    if (round >= RECOVERY_ROUNDS || !('document' in globalThis)) {
      return Effect.fail(error);
    }
    const retry = once.pipe(Effect.catch((error_: Failure) => recover(error_, round + 1)));
    if (releaseChanged(error)) {
      return Effect.sleep(recoveryDelayMillis(round)).pipe(
        Effect.andThen(currentReleaseRevision),
        Effect.flatMap((revision) => {
          if (revision !== undefined) {
            adoptCompositionRevision(revision);
          }
          return retry;
        }),
      );
    }
    if (transientlyUnavailable(error)) {
      return Effect.sleep(500 + recoveryDelayMillis(round)).pipe(Effect.andThen(retry));
    }
    return Effect.fail(error);
  };
  return once.pipe(Effect.catch((error: Failure) => recover(error, 0)));
};

const makeOperationGatewayWithIssuer = <Audience extends string, IssuerFailure>(
  audience: Audience,
  issuer: OperationGatewayIssuer<Audience, IssuerFailure>,
): OperationGateway<IssuerFailure> => {
  const acquireFor = (compositionRevision: string, options: GatewayContextClientOptions) =>
    issuer({ audience, compositionRevision }, options).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(GatewayContextResponseSchema, { onExcessProperty: 'error' })),
    );

  return {
    invoke: <Success, AttemptFailure>(
      attempt: OperationGatewayAttempt<Success, AttemptFailure>,
      options: GatewayContextClientOptions = {},
    ) =>
      recoveringAcrossDeploys(
        getDocumentCompositionRevision().pipe(
          Effect.flatMap((documentRevision) =>
            acquireFor(documentRevision, options).pipe(
              Effect.flatMap(
                ({
                  apiBaseUrl,
                  compositionRevision,
                  token,
                }): Effect.Effect<Success, AttemptFailure | DocumentCompositionRevisionError> => {
                  if (compositionRevision !== documentRevision) {
                    return Effect.fail(new DocumentCompositionRevisionError({ reason: 'revision-mismatch' }));
                  }
                  const authorization = Redacted.make(`Bearer ${token}`);
                  return attempt(Redacted.value(authorization), { apiBaseUrl, compositionRevision });
                },
              ),
            ),
          ),
        ),
      ),
  };
};

export function makeOperationGateway<const Audience extends string>(
  audience: Audience,
): OperationGateway<GatewayContextClientError>;
export function makeOperationGateway<const Audience extends string, IssuerFailure>(
  audience: Audience,
  acquire: OperationGatewayIssuer<Audience, IssuerFailure>,
): OperationGateway<IssuerFailure>;
export function makeOperationGateway<const Audience extends string, IssuerFailure>(
  audience: Audience,
  acquire?: OperationGatewayIssuer<Audience, IssuerFailure>,
): OperationGateway<GatewayContextClientError | IssuerFailure> {
  // Generated boundaries can pass the default issuer explicitly. Every invocation
  // still acquires its own single-use assertion, including concurrent attempts.
  return acquire === undefined || Object.is(acquire, issueGatewayContext)
    ? makeOperationGatewayWithIssuer(audience, browserGatewayContextIssuer)
    : makeOperationGatewayWithIssuer(audience, acquire);
}

/** Acquire an assertion for every receiving provider audience. */
export const makeReferenceGatewayCredentials = (audiences: readonly string[]) =>
  Effect.forEach(
    audiences,
    (audience) =>
      makeOperationGateway(audience).invoke((authorization) =>
        Effect.succeed({ audience, authorization: Redacted.make(authorization) }),
      ),
    { concurrency: 1 },
  ).pipe(
    Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(ReferenceGatewayCredentialsSchema))),
    Effect.map(Redacted.make),
  );
