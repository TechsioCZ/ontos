import { ExternalIdentityApi } from './external-identity.ts';
import type {
  ActivatePrincipalBindingRequestSchema,
  ChangePrincipalBindingStatusRequestSchema,
  ExternalGatewayContextRequestSchema,
  ExternalIdentityConflictProblemSchema,
  ExternalIdentityForbiddenProblemSchema,
  ExternalIdentityIneligibleProblemSchema,
  ExternalIdentityInternalProblemSchema,
  ExternalIdentityInvalidProblemSchema,
  ExternalIdentityNotFoundProblemSchema,
  ExternalIdentityThrottledProblemSchema,
  ExternalIdentityUnauthorizedProblemSchema,
  ExternalIdentityUnavailableProblemSchema,
  ResolveExternalSubjectRequestSchema,
  ReservePrincipalBindingRequestSchema,
} from './external-identity.ts';
import type { GatewayContextResponseSchema } from './gateway-context.ts';
import type {
  ActivatePrincipalBindingResultSchema,
  ChangePrincipalBindingStatusResultSchema,
  ReadPrincipalBindingPayloadSchema,
  ReadPrincipalBindingResultSchema,
  ResolveExternalSubjectResultSchema,
  ReservePrincipalBindingResultSchema,
} from '@app/core-runtime/auth/external-identity-contracts';
import type { HttpApi, HttpApiClient, HttpApiGroup, HttpClientError } from '@modern-js/bff-effect/effect-client';
import { Context, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';
import { makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client';

const ExternalIdentityRequestCorrelationSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

type ExternalIdentityApiGroups =
  typeof ExternalIdentityApi extends HttpApi.HttpApi<infer _ApiId, infer Groups> ? Groups : never;

/** The schema-derived client exposed by the shared neutral HTTP contract. */
export type ExternalIdentityGeneratedClient = HttpApiClient.Client<
  Extract<ExternalIdentityApiGroups, HttpApiGroup.Constraint>
>;

export type ReservePrincipalBindingRequest = Schema.Schema.Type<typeof ReservePrincipalBindingRequestSchema>;
export type ReservePrincipalBindingResult = Schema.Schema.Type<typeof ReservePrincipalBindingResultSchema>;
export type ActivatePrincipalBindingRequest = Schema.Schema.Type<typeof ActivatePrincipalBindingRequestSchema>;
export type ActivatePrincipalBindingResult = Schema.Schema.Type<typeof ActivatePrincipalBindingResultSchema>;
export type ChangePrincipalBindingStatusRequest = Schema.Schema.Type<typeof ChangePrincipalBindingStatusRequestSchema>;
export type ChangePrincipalBindingStatusResult = Schema.Schema.Type<typeof ChangePrincipalBindingStatusResultSchema>;
export type ReadPrincipalBindingRequest = Schema.Schema.Type<typeof ReadPrincipalBindingPayloadSchema>;
export type ReadPrincipalBindingResult = Schema.Schema.Type<typeof ReadPrincipalBindingResultSchema>;
export type ResolveExternalSubjectRequest = Schema.Schema.Type<typeof ResolveExternalSubjectRequestSchema>;
export type ResolveExternalSubjectResult = Schema.Schema.Type<typeof ResolveExternalSubjectResultSchema>;
export type ExternalGatewayContextRequest = Schema.Schema.Type<typeof ExternalGatewayContextRequestSchema>;

export type ExternalIdentityProblem =
  | Schema.Schema.Type<typeof ExternalIdentityConflictProblemSchema>
  | Schema.Schema.Type<typeof ExternalIdentityForbiddenProblemSchema>
  | Schema.Schema.Type<typeof ExternalIdentityIneligibleProblemSchema>
  | Schema.Schema.Type<typeof ExternalIdentityInternalProblemSchema>
  | Schema.Schema.Type<typeof ExternalIdentityInvalidProblemSchema>
  | Schema.Schema.Type<typeof ExternalIdentityNotFoundProblemSchema>
  | Schema.Schema.Type<typeof ExternalIdentityThrottledProblemSchema>
  | Schema.Schema.Type<typeof ExternalIdentityUnauthorizedProblemSchema>
  | Schema.Schema.Type<typeof ExternalIdentityUnavailableProblemSchema>;

export type ExternalIdentityClientError =
  | ExternalIdentityProblem
  | HttpClientError.HttpClientError
  | Schema.SchemaError;

/**
 * The service credential is a trusted, server-owned API key. It is deliberately
 * independent from authenticationRef and the external subject carried in a
 * request. Shell verifies the key and its current binding on every request.
 */
export interface ExternalIdentityClientOptions {
  readonly apiKey: Redacted.Redacted;
  readonly baseUrl: string | URL;
  readonly requestCorrelation: string;
}

export interface ExternalIdentityMutationClientOptions extends ExternalIdentityClientOptions {
  readonly idempotencyKey: string;
}

/** Transport configuration is supplied by server composition, never by external subject input. */
export const ExternalIdentityTransport = Context.Reference<Option.Option<ExternalIdentityClientOptions>>(
  '@app/shared-contracts/external-identity-client/ExternalIdentityTransport',
  { defaultValue: Option.none },
);

export const externalIdentityTransportLayer = (options: ExternalIdentityClientOptions) =>
  Layer.succeed(ExternalIdentityTransport, Option.some(options));

export type ExternalIdentityClientEffect<Success> = Effect.Effect<Success, ExternalIdentityClientError>;

const externalIdentityHttpClient = makeEffectHttpApiClient(ExternalIdentityApi, {
  transformClient: HttpClient.mapRequestEffect((request) =>
    ExternalIdentityTransport.pipe(
      Effect.map(
        Option.match({
          onNone: () => request,
          onSome: (options) => {
            let nextRequest = HttpClientRequest.prependUrl(request, options.baseUrl.toString());
            nextRequest = HttpClientRequest.setHeader(nextRequest, 'x-api-key', Redacted.value(options.apiKey));
            return HttpClientRequest.setHeader(nextRequest, 'x-correlation-id', options.requestCorrelation);
          },
        }),
      ),
    ),
  ),
});

const invokeExternalIdentity = <Success>(
  options: ExternalIdentityClientOptions,
  operation: (client: ExternalIdentityGeneratedClient) => Effect.Effect<Success, ExternalIdentityClientError>,
): ExternalIdentityClientEffect<Success> =>
  Schema.decodeEffect(ExternalIdentityRequestCorrelationSchema)(options.requestCorrelation).pipe(
    Effect.flatMap(() => externalIdentityHttpClient.pipe(Effect.flatMap(operation))),
    Effect.updateService(ExternalIdentityTransport, () => Option.some(options)),
  );

const mutationHeaders = (options: ExternalIdentityMutationClientOptions) => ({
  'idempotency-key': options.idempotencyKey,
  'x-correlation-id': options.requestCorrelation,
});

/** Reserve a neutral binding using the owner-supplied opaque authenticationRef. */
export const reservePrincipalBinding = (
  payload: ReservePrincipalBindingRequest,
  options: ExternalIdentityMutationClientOptions,
): ExternalIdentityClientEffect<ReservePrincipalBindingResult> =>
  invokeExternalIdentity(options, (client) =>
    client.externalIdentity.reservePrincipalBinding({
      headers: mutationHeaders(options),
      payload,
    }),
  );

/** Activate a pending binding after the owner has supplied fresh same-subject proof. */
export const activatePrincipalBinding = (
  payload: ActivatePrincipalBindingRequest,
  options: ExternalIdentityMutationClientOptions,
): ExternalIdentityClientEffect<ActivatePrincipalBindingResult> =>
  invokeExternalIdentity(options, (client) =>
    client.externalIdentity.activatePrincipalBinding({
      headers: mutationHeaders(options),
      payload,
    }),
  );

/** Apply an administrative status transition; the server decides whether proof is required. */
export const changePrincipalBindingStatus = (
  payload: ChangePrincipalBindingStatusRequest,
  options: ExternalIdentityMutationClientOptions,
): ExternalIdentityClientEffect<ChangePrincipalBindingStatusResult> =>
  invokeExternalIdentity(options, (client) =>
    client.externalIdentity.changePrincipalBindingStatus({
      headers: mutationHeaders(options),
      payload,
    }),
  );

/** Read a binding by exact binding ID or namespace-qualified external subject. */
export const readPrincipalBinding = (
  payload: ReadPrincipalBindingRequest,
  options: ExternalIdentityClientOptions,
): ExternalIdentityClientEffect<ReadPrincipalBindingResult> =>
  invokeExternalIdentity(options, (client) => {
    if (payload.lookup === 'binding') {
      return client.externalIdentity.readPrincipalBinding({
        payload: { authBindingId: payload.authBindingId, lookup: payload.lookup },
      });
    }
    return client.externalIdentity.readPrincipalBinding({
      payload: {
        authenticationNamespaceId: payload.authenticationNamespaceId,
        lookup: payload.lookup,
        providerSubjectId: payload.providerSubjectId,
        subjectType: payload.subjectType,
      },
    });
  });

/** Resolve an active namespace-qualified external subject with an opaque owner evidence reference. */
export const resolveExternalSubject = (
  payload: ResolveExternalSubjectRequest,
  options: ExternalIdentityClientOptions,
): ExternalIdentityClientEffect<ResolveExternalSubjectResult> =>
  invokeExternalIdentity(options, (client) => client.externalIdentity.resolveExternalSubject({ payload }));

/** Issue a fresh audience-bound gateway context after Shell revalidates the external binding. */
export const issueExternalGatewayContext = (
  payload: ExternalGatewayContextRequest,
  options: ExternalIdentityClientOptions,
): ExternalIdentityClientEffect<Schema.Schema.Type<typeof GatewayContextResponseSchema>> =>
  invokeExternalIdentity(options, (client) => client.externalIdentity.issueExternalGatewayContext({ payload }));

export interface ExternalIdentityClientPort {
  readonly activatePrincipalBinding: typeof activatePrincipalBinding;
  readonly changePrincipalBindingStatus: typeof changePrincipalBindingStatus;
  readonly issueExternalGatewayContext: typeof issueExternalGatewayContext;
  readonly readPrincipalBinding: typeof readPrincipalBinding;
  readonly reservePrincipalBinding: typeof reservePrincipalBinding;
  readonly resolveExternalSubject: typeof resolveExternalSubject;
}

/** Context seam for server composition; no caller can supply a customer session as service authority. */
export class ExternalIdentityClient extends Context.Service<ExternalIdentityClient, ExternalIdentityClientPort>()(
  '@app/shared-contracts/external-identity-client/ExternalIdentityClient',
) {}
