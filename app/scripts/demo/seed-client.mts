import { randomUUID } from 'node:crypto';

import { Effect, Redacted, Schema } from 'effect';
import type { Headers } from 'effect/unstable/http';
import { Cookies, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http';

export class DemoSeedError extends Schema.TaggedError<DemoSeedError>()('DemoSeedError', {
  reason: Schema.String,
}) {}

export interface SeedTarget {
  readonly legalEntityId: string;
  readonly shellUrl: string;
  readonly tenantId: string;
}
export const validateSeedTarget = (target: SeedTarget) =>
  Effect.gen(function* validateTarget() {
    const url = yield* Schema.decodeUnknownEffect(Schema.URLFromString)(target.shellUrl);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      !(
        url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      )
    ) {
      return yield* new DemoSeedError({
        reason: 'Use an HTTPS server origin, or HTTP on loopback, without credentials or a path.',
      });
    }
    yield* Schema.decodeUnknownEffect(Schema.String.check(Schema.isUUID()))(target.tenantId);
    yield* Schema.decodeUnknownEffect(Schema.String.check(Schema.isUUID()))(target.legalEntityId);
    return url.origin;
  });

const SignIn = Schema.Struct({ email: Schema.String, password: Schema.Redacted(Schema.String) });
export const SeedTenantId = Schema.toEncoded(Schema.String.pipe(Schema.brand('TenantId')));
export const SeedLegalEntityId = Schema.toEncoded(Schema.String.pipe(Schema.brand('LegalEntityId')));
const Tenant = Schema.Struct({ tenantId: SeedTenantId });
const LegalEntity = Schema.Struct({ legalEntityId: SeedLegalEntityId });
const Session = Schema.Struct({
  identity: Schema.Struct({ legalEntityId: SeedLegalEntityId, tenantId: SeedTenantId }),
  state: Schema.Literal('authenticated'),
});
const Composition = Schema.Struct({ compositionRevision: Schema.String, state: Schema.Literal('available') });
const GatewayRequest = Schema.Struct({
  audience: Schema.String,
  compositionRevision: Schema.String,
  legalEntityId: SeedLegalEntityId,
});
const Gateway = Schema.Struct({
  apiBaseUrl: Schema.String,
  compositionRevision: Schema.String,
  token: Schema.Redacted(Schema.String),
});
const Empty = Schema.Struct({});
const Revision = Schema.Struct({ revision: Schema.Int });

const checked = (response: HttpClientResponse.HttpClientResponse, operation: string) =>
  response.status >= 200 && response.status < 300
    ? Effect.succeed(response)
    : response.text.pipe(
        Effect.orElseSucceed(() => ''),
        Effect.flatMap((body) =>
          Effect.fail(
            new DemoSeedError({
              reason: `${operation}: HTTP ${response.status} ${body.slice(0, 600)}. No automatic write retry; rerun after resolving the failure.`,
            }),
          ),
        ),
      );
const post = <P extends Schema.Top>(
  origin: string,
  path: string,
  schema: P,
  payload: P['Type'],
  headers: Headers.Input,
) =>
  Effect.gen(function* postRequest() {
    const http = yield* HttpClient.HttpClient;
    const request = yield* HttpClientRequest.schemaBodyJson(schema)(
      HttpClientRequest.post(`${origin}${path}`).pipe(
        HttpClientRequest.setHeaders(headers),
        HttpClientRequest.setHeaders({ origin, 'x-correlation-id': randomUUID() }),
      ),
      payload,
    );
    const response = yield* http.execute(request).pipe(Effect.timeout('30 seconds'));
    return yield* checked(response, path);
  });
const ReferenceCredentials = Schema.Array(
  Schema.Struct({
    audience: Schema.String.pipe(Schema.brand('GatewayAudience')).pipe(Schema.toEncoded),
    authorization: Schema.RedactedFromValue(Schema.String),
  }),
);

const encodeReferenceCredentials = (
  audiences: readonly string[],
  issue: (audience: string) => ReturnType<typeof issueSeedAssertion>,
) =>
  Effect.forEach(
    audiences,
    (audience) =>
      issue(audience).pipe(
        Effect.map(({ token }) => ({ audience, authorization: Redacted.make(`Bearer ${Redacted.value(token)}`) })),
      ),
    { concurrency: 1 },
  ).pipe(Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(ReferenceCredentials))));

const issueSeedAssertion = (
  target: SeedTarget,
  origin: string,
  cookie: string,
  compositionRevision: string,
  audience: string,
) =>
  post(
    origin,
    '/shell-super-app-api/auth/gateway-context',
    GatewayRequest,
    {
      audience,
      compositionRevision,
      legalEntityId: target.legalEntityId,
    },
    { cookie },
  ).pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Gateway)));
export type SeedWriteCheckpoint = (
  audience: string,
  path: string,
  payload: string,
) => Effect.Effect<string, DemoSeedError>;

const makeOwnerClient = (
  target: SeedTarget,
  origin: string,
  cookie: string,
  compositionRevision: string,
  checkpoint?: SeedWriteCheckpoint,
) => {
  const issue = (audience: string) => issueSeedAssertion(target, origin, cookie, compositionRevision, audience);
  const call = <P extends Schema.Top, R extends Schema.Top>(
    audience: string,
    path: string,
    payloadSchema: P,
    payload: P['Type'],
    resultSchema: R,
    write = false,
    referenceAudiences: readonly string[] = [],
  ) =>
    Effect.gen(function* callOwner() {
      const assertion = yield* issue(audience);
      if (
        !assertion.apiBaseUrl.startsWith('/') ||
        assertion.apiBaseUrl.startsWith('//') ||
        assertion.apiBaseUrl.includes('?') ||
        assertion.apiBaseUrl.includes('#')
      ) {
        return yield* new DemoSeedError({ reason: 'Gateway must publish an origin-relative owner API route.' });
      }
      let idempotencyKey: string | undefined;
      if (write) {
        idempotencyKey =
          checkpoint === undefined
            ? randomUUID()
            : yield* checkpoint(
                audience,
                path,
                yield* Schema.encodeEffect(Schema.fromJsonString(payloadSchema))(payload),
              );
      }
      const headers = {
        authorization: `Bearer ${Redacted.value(assertion.token)}`,
        'idempotency-key': idempotencyKey,
        'x-ontos-composition-revision': assertion.compositionRevision,
        'x-ontos-reference-credentials':
          referenceAudiences.length > 0 ? yield* encodeReferenceCredentials(referenceAudiences, issue) : undefined,
      };
      const response = yield* post(origin, `${assertion.apiBaseUrl}${path}`, payloadSchema, payload, headers);
      return yield* HttpClientResponse.schemaBodyJson(resultSchema)(response);
    });
  const read = <R extends Schema.Top>(audience: string, schema: R) =>
    call(audience, '/reads/records', Empty, {}, schema);
  const apply = <P extends Schema.Top>(
    audience: string,
    schema: P,
    command: P['Type'],
    expectedRevision: number,
    referenceAudiences: readonly string[] = [],
  ) =>
    Effect.gen(function* applyCommand() {
      const payloadSchema = Schema.Struct({ command: schema, expectedRevision: Schema.Int });
      const payload = yield* Schema.decodeUnknownEffect(payloadSchema)({ command, expectedRevision });
      return yield* call(
        audience,
        `/${audience}/actions/apply-command`,
        payloadSchema,
        payload,
        Revision,
        true,
        referenceAudiences,
      );
    });
  /** Native generated clients retain typed owner errors and invocation recovery for multi-step operator jobs. */
  const authorize = (audience: string) =>
    issue(audience).pipe(
      Effect.map((assertion) => ({
        credential: Redacted.make(`Bearer ${Redacted.value(assertion.token)}`),
        options: {
          baseUrl: new URL(assertion.apiBaseUrl, origin).toString(),
          compositionRevision: assertion.compositionRevision,
        },
      })),
    );
  return { apply, authorize, call, read };
};

export const connectSeedClient = (
  target: SeedTarget,
  email: string,
  password: Redacted.Redacted,
  checkpoint?: SeedWriteCheckpoint,
) =>
  Effect.gen(function* connect() {
    const origin = yield* validateSeedTarget(target);
    const http = yield* HttpClient.HttpClient;
    const login = yield* post(origin, '/shell-super-app-api/auth/sign-in', SignIn, { email, password }, {});
    let { cookies } = login;
    const shell = <P extends Schema.Top>(path: string, schema: P, payload: P['Type']) =>
      Effect.gen(function* shellRequest() {
        const response = yield* post(origin, path, schema, payload, { cookie: Cookies.toCookieHeader(cookies) });
        cookies = Cookies.merge(cookies, response.cookies);
        return response;
      });
    yield* shell('/shell-super-app-api/auth/tenant/switch', Tenant, { tenantId: target.tenantId });
    yield* shell('/shell-super-app-api/auth/legal-entity/switch', LegalEntity, { legalEntityId: target.legalEntityId });
    const get = (path: string) =>
      http.get(`${origin}${path}`, { headers: { cookie: Cookies.toCookieHeader(cookies) } }).pipe(
        Effect.timeout('30 seconds'),
        Effect.flatMap((response) => checked(response, path)),
      );
    const session = yield* get('/shell-super-app-api/auth/session').pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Session)),
    );
    if (session.identity.tenantId !== target.tenantId || session.identity.legalEntityId !== target.legalEntityId) {
      return yield* new DemoSeedError({ reason: 'Authenticated session does not match the explicit seed target.' });
    }
    const composition = yield* get('/shell-super-app-api/shell/composition').pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Composition)),
    );
    return makeOwnerClient(
      target,
      origin,
      Cookies.toCookieHeader(cookies),
      composition.compositionRevision,
      checkpoint,
    );
  });
export type SeedClient = Effect.Success<ReturnType<typeof connectSeedClient>>;
