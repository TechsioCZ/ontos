import { GatewayDelegatedContextRequestSchema, shellGatewayContextContract } from '@app/shared-contracts';
import { ConfigProvider, Effect, Match, Schema } from 'effect';
import { HttpServerRequest, HttpServerResponse } from 'effect/http';

/** The Shell route the delegated client calls. Fixtures serve it on their own origin. */
export const delegatedGatewayRoute = shellGatewayContextContract.issueDelegatedGatewayContextPath;

/**
 * Caller-side configuration of the delegated client: this deployment's module key, and the Shell base
 * URL the client prepends to the delegated route.
 */
export const delegatedGatewayConfiguration = (shellOrigin: URL) =>
  ConfigProvider.fromUnknown({
    ONTOS_GATEWAY_MODULE_API_KEY: 'fixture-module-api-key',
    ONTOS_SHELL_GATEWAY_BASE_URL: new URL(shellGatewayContextContract.apiPrefix, shellOrigin).toString(),
  });

export interface DelegatedGatewayGrant {
  /** Relative path the Shell returns. The client resolves it against the Shell base URL. */
  readonly apiBaseUrl: string;
  readonly audience: string;
  readonly compositionRevision: string;
  /** Mints the bearer for an admitted request, as the Shell would from its own verified state. */
  readonly token: Effect.Effect<string>;
}

type DelegatedSubject = Schema.Schema.Type<typeof GatewayDelegatedContextRequestSchema>['subject'];

const isAssertionSubject = (subject: DelegatedSubject): boolean =>
  Match.value(subject).pipe(
    Match.tag('Assertion', () => true),
    Match.tag('Originator', () => false),
    Match.exhaustive,
  );

/**
 * Stands in for the Shell's delegated issuance route. It admits only the grant's audience, release and
 * an Assertion subject, and answers with the bearer and owner base path the grant names.
 */
export const serveDelegatedGatewayContext = (grant: DelegatedGatewayGrant) =>
  Effect.gen(function* serveDelegatedGatewayContextRoute() {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const payload = yield* request.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(GatewayDelegatedContextRequestSchema)),
      Effect.orElseSucceed(() => null),
    );
    if (
      payload === null ||
      payload.audience !== grant.audience ||
      payload.compositionRevision !== grant.compositionRevision ||
      !isAssertionSubject(payload.subject)
    ) {
      return HttpServerResponse.text('Delegated gateway context refused by the fixture Shell', { status: 403 });
    }
    const token = yield* grant.token;
    return yield* HttpServerResponse.json({
      apiBaseUrl: grant.apiBaseUrl,
      compositionRevision: payload.compositionRevision,
      expiresAt: 2_000_000_000,
      token,
    });
  });
