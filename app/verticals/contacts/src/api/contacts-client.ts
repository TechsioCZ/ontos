/* eslint-disable oxc/no-barrel-file, sonarjs/no-wildcard-import -- This is the published contract-derived client aggregate for governed Contacts operations. */
import type { GatewayContextClientOptions } from '@app/shared-contracts';
import { Effect, makeEffectHttpApiClient } from '@modern-js/plugin-bff/effect-client';
import type {
  HttpApi,
  HttpApiClient,
  HttpApiGroup,
  HttpClientError,
  Schema,
} from '@modern-js/plugin-bff/effect-client';
import { Context, Redacted } from 'effect';
import type { Cause } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';
import { contactsApi, contactsApiContract, contactsOperationContexts } from '../../shared/api.ts';
import type {
  AttachOrganizationEngagementPayload,
  AttachPersonEngagementPayload,
  ContactsReadiness,
  OperationContext,
  OrganizationEngagementLifecyclePayload,
  PersonEngagementLifecyclePayload,
} from '../../shared/api.ts';
import { actionGateway } from './action-gateway.ts';

export * from './organization-engagement-profile-client.ts';
export * from './person-engagement-profile-client.ts';
export { Effect, runEffectRequest } from '@modern-js/plugin-bff/effect-client';

type ContactsApiGroups =
  typeof contactsApi extends HttpApi.HttpApi<infer _ApiId, infer Groups> ? Groups : never;

export type ContactsClient = HttpApiClient.Client<
  Extract<ContactsApiGroups, HttpApiGroup.Constraint>
>;
export type ContactsClientError = HttpClientError.HttpClientError | Schema.SchemaError;
export type ContactsClientEffect<Success> = Effect.Effect<Success, ContactsClientError>;
/** Operations this module runs also carry a deadline, so `TimeoutError` joins their failures. */
export type ContactsOperationEffect<Success> = Effect.Effect<
  Success,
  ContactsClientError | Cause.TimeoutError
>;

/** Preserve the generated operations while adding their deadline failure to the typed channel. */
export type ContactsDeadlineClient = {
  [Group in keyof ContactsClient]: {
    [Operation in keyof ContactsClient[Group]]: ContactsClient[Group][Operation] extends (
      ...args: infer Args
    ) => Effect.Effect<infer Success, infer Failure, infer Requirements>
      ? (...args: Args) => Effect.Effect<Success, Failure | Cause.TimeoutError, Requirements>
      : ContactsClient[Group][Operation];
  };
};

export interface ContactsClientOptions {
  readonly baseUrl?: string | URL;
  readonly locale?: string;
  readonly operationContext?: OperationContext;
  /** Request + decode deadline, default 10s. Mutations budget gateway acquisition separately. */
  readonly timeoutMs?: number;
  readonly traceparent?: string;
}

export interface ContactsOperationOptions extends ContactsClientOptions {
  readonly correlationId: string;
  readonly gateway?: GatewayContextClientOptions;
  readonly traceId?: string;
}

export interface ContactsMutationOptions extends ContactsOperationOptions {
  readonly idempotencyKey: string;
}

interface ContactsClientAuthorization {
  readonly authorization: Redacted.Redacted<string>;
  readonly correlationId: string;
  readonly traceId?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** What one in-flight call contributes to its request; never held by the shared client. */
interface ContactsCallTransport {
  readonly baseUrl: string;
  readonly contextHeaders: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * A `Context.Reference` rather than a `Context.Service`: it carries a default, so every public
 * Effect keeps `R = never` and the Action boundary still calls them without providing anything.
 * The default is fail-closed — a request issued outside a prepared call dies instead of silently
 * borrowing whichever credential happened to be in scope.
 */
const CurrentContactsCall = Context.Reference<ContactsCallTransport | null>(
  'contacts/CurrentContactsCall',
  { defaultValue: () => null },
);

/**
 * Applies the *current* call's prefix and headers. `HttpClient.mapRequestEffect` resolves its effect
 * in the fiber that executes the request, so interleaved calls each read their own transport off one
 * shared client instead of each needing a client of their own.
 *
 * Precedence is the one `makeEffectHttpApiClient` used while it still received `requestContext` at
 * construction: the authorization headers are set outright, and the request-context pair only fills
 * headers the request does not already carry.
 */
const applyCallTransport = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
  HttpClient.mapRequestEffect(client, (request) =>
    Effect.flatMap(Effect.service(CurrentContactsCall), (transport) => {
      if (transport === null) {
        return Effect.die('The Contacts client was used outside a prepared call');
      }
      const authorized = HttpClientRequest.setHeaders(request, transport.headers);
      const absent = Object.entries(transport.contextHeaders).filter(
        ([header]) => authorized.headers[header] === undefined,
      );
      return Effect.succeed(
        authorized.pipe(
          HttpClientRequest.setHeaders(Object.fromEntries(absent)),
          HttpClientRequest.prependUrl(transport.baseUrl),
        ),
      );
    }),
  );

/**
 * The module's single typed client, built once on its own root fiber at module load.
 *
 * Both captures made during construction outlive the fiber that built them: `HttpApiClient` keeps
 * `Effect.context()` for middleware lookup, and `FetchHttpClient.layer` merges the build-time
 * context *under* every later request. Building inside the first caller would therefore pin that
 * caller's `FetchHttpClient.Fetch`, logger, span and refs onto every later call — contamination, not
 * reuse. Building here leaves both captures empty.
 *
 * `baseUrl` and `requestContext` are deliberately not passed: this version of
 * `makeEffectHttpApiClient` bakes the prefix into the transport and resolves the request-context
 * headers once at construction, so per-call values there would force a client per call. Both move to
 * `applyCallTransport` instead.
 */
const contactsClient: ContactsClient = Effect.runSync(
  makeEffectHttpApiClient(contactsApi, { transformClient: applyCallTransport }),
);

/**
 * The whole wire effect `requestContext` ever had: `createRequestContextHeaders` maps `locale` to
 * `accept-language` and `traceparent` to `traceparent`. Contacts' `OperationContext` declares
 * neither field, so the operation context itself never contributed a header — it stays a public
 * option and continues to reach nothing on the wire.
 */
const requestContextHeaders = (options: ContactsClientOptions) => {
  const headers: Record<string, string> = {};
  if (options.locale !== undefined && options.locale.length > 0) {
    headers['accept-language'] = options.locale;
  }
  if (options.traceparent !== undefined && options.traceparent.length > 0) {
    headers['traceparent'] = options.traceparent;
  }
  return headers;
};

/** No headers at all without authentication, exactly as the unauthenticated client had none. */
const authorizationHeaders = (authentication?: ContactsClientAuthorization) => {
  const headers: Record<string, string> = {};
  if (authentication !== undefined) {
    // The outgoing header record is the single boundary that unwraps the assertion; the encoded
    // wire header stays the same `authorization: Bearer …` string the owner deployment accepts.
    headers['authorization'] = Redacted.value(authentication.authorization);
    headers['x-correlation-id'] = authentication.correlationId;
    if (authentication.traceId !== undefined) {
      headers['x-trace-id'] = authentication.traceId;
    }
  }
  return headers;
};

const callTransport = (
  options: ContactsClientOptions,
  authentication?: ContactsClientAuthorization,
): ContactsCallTransport => ({
  baseUrl: (options.baseUrl ?? contactsApiContract.apiPrefix).toString(),
  contextHeaders: requestContextHeaders(options),
  headers: authorizationHeaders(authentication),
});

const deadlineOf = (options: ContactsClientOptions) => options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

/**
 * Bind transport and request + decode deadline to each returned Effect, not the factory's fiber.
 * Enumerating operations makes a newly added endpoint a compile-time omission rather than a silent one.
 */
const bindCall = (transport: ContactsCallTransport, deadlineMs: number): ContactsDeadlineClient => {
  const onCall = <Success, Failure>(operation: Effect.Effect<Success, Failure>) =>
    operation.pipe(
      Effect.provideService(CurrentContactsCall, transport),
      // Timeout never replays a write or establishes whether it committed.
      Effect.timeout(deadlineMs),
    );
  const { foundation, organizationEngagementMutations, personEngagementMutations } = contactsClient;
  return {
    foundation: {
      readiness: (request) => onCall(foundation.readiness(request)),
    },
    organizationEngagementMutations: {
      archive: (request) => onCall(organizationEngagementMutations.archive(request)),
      attach: (request) => onCall(organizationEngagementMutations.attach(request)),
      unarchive: (request) => onCall(organizationEngagementMutations.unarchive(request)),
    },
    organizationEngagementProfile: {
      execute: (request) => onCall(contactsClient.organizationEngagementProfile.execute(request)),
    },
    personEngagementMutations: {
      archive: (request) => onCall(personEngagementMutations.archive(request)),
      attach: (request) => onCall(personEngagementMutations.attach(request)),
      unarchive: (request) => onCall(personEngagementMutations.unarchive(request)),
    },
    personEngagementProfile: {
      execute: (request) => onCall(contactsClient.personEngagementProfile.execute(request)),
    },
  };
};

/** Reuse the shared schema client with this caller's transport and per-operation deadline. */
export const createContactsClient = (
  options: ContactsClientOptions = {},
): ContactsClientEffect<ContactsDeadlineClient> =>
  Effect.succeed(bindCall(callTransport(options), deadlineOf(options)));

const invoke = <Success, Failure>(
  options: ContactsOperationOptions,
  context: OperationContext,
  operation: (client: ContactsClient) => Effect.Effect<Success, Failure>,
) =>
  actionGateway.invoke((authorization) => {
    const operationContext =
      options.operationContext ??
      (options.traceId === undefined ? context : { ...context, traceId: options.traceId });
    const authentication =
      options.traceId === undefined
        ? { authorization, correlationId: options.correlationId }
        : { authorization, correlationId: options.correlationId, traceId: options.traceId };
    return operation(contactsClient).pipe(
      Effect.provideService(
        CurrentContactsCall,
        callTransport({ ...options, operationContext }, authentication),
      ),
      // Gateway acquisition has its own budget. This deadline covers request + decode;
      // a timed-out write has an unknown commit outcome and is never replayed here.
      Effect.timeout(deadlineOf(options)),
    );
  }, options.gateway);

const mutationHeaders = (options: ContactsMutationOptions) => ({
  'idempotency-key': options.idempotencyKey,
});

export const getContactsReadiness = (
  options: ContactsClientOptions = {},
): ContactsOperationEffect<ContactsReadiness> =>
  contactsClient.foundation.readiness({}).pipe(
    Effect.provideService(
      CurrentContactsCall,
      callTransport({
        ...options,
        operationContext: options.operationContext ?? contactsOperationContexts.readiness,
      }),
    ),
    Effect.timeout(deadlineOf(options)),
  );

export const attachOrganizationEngagement = (
  payload: AttachOrganizationEngagementPayload,
  options: ContactsMutationOptions,
) =>
  invoke(options, contactsOperationContexts.attachOrganizationEngagement, (client) =>
    client.organizationEngagementMutations.attach({
      headers: mutationHeaders(options),
      payload,
    }),
  );

export const archiveOrganizationEngagement = (
  payload: OrganizationEngagementLifecyclePayload,
  options: ContactsMutationOptions,
) =>
  invoke(options, contactsOperationContexts.archiveOrganizationEngagement, (client) =>
    client.organizationEngagementMutations.archive({
      headers: mutationHeaders(options),
      payload,
    }),
  );

export const unarchiveOrganizationEngagement = (
  payload: OrganizationEngagementLifecyclePayload,
  options: ContactsMutationOptions,
) =>
  invoke(options, contactsOperationContexts.unarchiveOrganizationEngagement, (client) =>
    client.organizationEngagementMutations.unarchive({
      headers: mutationHeaders(options),
      payload,
    }),
  );

export const attachPersonEngagement = (
  payload: AttachPersonEngagementPayload,
  options: ContactsMutationOptions,
) =>
  invoke(options, contactsOperationContexts.attachPersonEngagement, (client) =>
    client.personEngagementMutations.attach({ headers: mutationHeaders(options), payload }),
  );

export const archivePersonEngagement = (
  payload: PersonEngagementLifecyclePayload,
  options: ContactsMutationOptions,
) =>
  invoke(options, contactsOperationContexts.archivePersonEngagement, (client) =>
    client.personEngagementMutations.archive({ headers: mutationHeaders(options), payload }),
  );

export const unarchivePersonEngagement = (
  payload: PersonEngagementLifecyclePayload,
  options: ContactsMutationOptions,
) =>
  invoke(options, contactsOperationContexts.unarchivePersonEngagement, (client) =>
    client.personEngagementMutations.unarchive({ headers: mutationHeaders(options), payload }),
  );
