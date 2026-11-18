import { ConfigProvider, Schema } from 'effect';

/** The Shell delegated issuance route, as the actual delegated client addresses it. */
export const delegatedGatewayPath = '/shell-super-app-api/auth/delegated/gateway-context';
/** The owner base path the fake Shell names for every delegated audience. */
export const ownerApiBasePath = '/owner-api';
export const ownerBearer = 'Bearer owner-token';

/** Caller configuration of the actual delegated client: this deployment's module key and the Shell origin. */
export const ownerTransportConfiguration = ConfigProvider.fromUnknown({
  ONTOS_GATEWAY_MODULE_API_KEY: 'pricing-unit-module-key',
  ONTOS_SHELL_GATEWAY_BASE_URL: 'https://shell.unit.invalid/shell-super-app-api',
});

/** What the fake Shell records of each delegation it answered. */
const DelegatedRequestSchema = Schema.fromJsonString(
  Schema.Struct({
    audience: Schema.String,
    compositionRevision: Schema.String,
    legalEntityScope: Schema.String,
    subject: Schema.Struct({ _tag: Schema.String, sourceAssertion: Schema.optionalKey(Schema.String) }),
  }),
);

type DelegatedRequest = typeof DelegatedRequestSchema.Type;

/** The bytes the actual Effect fetch transport hands to `fetch` as the request body. */
const bodyText = (body: RequestInit['body']): string => {
  if (Schema.is(Schema.String)(body)) {
    return body;
  }
  return ArrayBuffer.isView(body) ? new TextDecoder().decode(body) : '';
};

export interface OwnerTransportRoute {
  /** Owner route path below the owner base path, answered with the given owner wire body. */
  readonly path: string;
  readonly respond: () => Response;
}

/**
 * Fake HTTP peers behind the actual Effect transport: the Shell issues one owner bearer under the given
 * composition for every delegation and records what it was asked; each owner answers its declared route.
 * Anything else is an unknown route. A test installs `answer` as its `FetchHttpClient.Fetch`.
 */
export const makeOwnerTransport = (compositionRevision: string, routes: readonly OwnerTransportRoute[]) => {
  const requests: Request[] = [];
  const delegations: DelegatedRequest[] = [];
  const answer = (input: RequestInfo | URL, init?: RequestInit): Response => {
    const request = new Request(input, init);
    requests.push(request);
    const { pathname } = new URL(request.url);
    if (pathname === delegatedGatewayPath) {
      delegations.push(Schema.decodeUnknownSync(DelegatedRequestSchema)(bodyText(init?.body)));
      return Response.json({
        apiBaseUrl: ownerApiBasePath,
        compositionRevision,
        expiresAt: 2_000_000_000,
        token: 'owner-token',
      });
    }
    const route = routes.find((candidate) => pathname === `${ownerApiBasePath}${candidate.path}`);
    return route === undefined ? Response.json({ detail: 'Unknown owner route' }, { status: 404 }) : route.respond();
  };
  const requestsTo = (path: string) => requests.filter((request) => new URL(request.url).pathname.endsWith(path));
  return { answer, delegations, requests, requestsTo };
};
