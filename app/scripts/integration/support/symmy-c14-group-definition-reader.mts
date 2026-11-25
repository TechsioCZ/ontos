import { executeConfigureCustomerSourceRouteWithAuthorization } from '@app/commerce-customer-context/api/client';
import type { CustomerGroupSourceAuthorityFixtureRoute } from '@app/commerce-customer-context/testing/customer-group-source-authority';
import { PrincipalIdSchema } from '@app/core-runtime/access/ids';
import { grantTestTenantRoleAccess, liveFixtureSpiceDb } from '@app/core-runtime/testing/tenant-access';
import type { makeApiKeyGatewayNativeFixture } from '@app/shell-super-app/testing/api-key-gateway-native';
import type { Redacted } from 'effect';
import { Config, Effect, Match, Option, Schema } from 'effect';

import { customerFixtureUuid } from './symmy-c14-customer-native-authority.mts';
import { SymmyC14ProductFixtureUnavailable } from './symmy-c14-product-runtime.mts';

type ShellFixture = Effect.Success<ReturnType<typeof makeApiKeyGatewayNativeFixture>>;
const decodePrincipal = Schema.decodeUnknownEffect(PrincipalIdSchema);
const refused = (outcome: string) =>
  new SymmyC14ProductFixtureUnavailable({
    message: `Commerce did not name the Group definition route reader: ${outcome}`,
  });

/**
 * The Tenant's human administrator names the API-key integration principal as a reader of a seeded Group definition
 * route through Commerce's governed route configuration Action, in a session the Shell issues for that human: the
 * whole stored route restated with the reader, decided against the generation 1 the route was stored at. Commerce
 * stores it only if Core binds the reader, an integration principal, to its source-read workload.
 */
export const nameGroupDefinitionRouteReader = Effect.fn('SymmyC14Group.nameDefinitionRouteReader')(
  function* nameGroupDefinitionRouteReader(input: {
    readonly adminConnectionString: Redacted.Redacted;
    readonly administratorPrincipalId: string;
    readonly commerceBaseUrl: string;
    readonly compositionRevision: string;
    readonly readerPrincipalId: string;
    readonly route: CustomerGroupSourceAuthorityFixtureRoute;
    readonly shell: Pick<ShellFixture, 'issueFixtureSetupGateway'>;
  }) {
    const { route } = input;
    const spiceEnvironment = yield* Config.all({
      SPICEDB_CA_CERT: Config.String('SPICEDB_CA_CERT'),
      SPICEDB_ENDPOINT: Config.String('SPICEDB_ENDPOINT'),
      SPICEDB_PRESHARED_KEY: Config.Redacted('SPICEDB_PRESHARED_KEY'),
    });
    yield* grantTestTenantRoleAccess({
      adminConnectionString: input.adminConnectionString,
      holders: [
        {
          capabilityKeys: ['commerce.customer-context.customer-source-route.configure'],
          principalId: input.administratorPrincipalId,
        },
      ],
      legalEntityIds: [route.legalEntityId],
      spiceDb: yield* liveFixtureSpiceDb(spiceEnvironment),
      tenantId: route.tenantId,
    });
    const writer = yield* decodePrincipal(route.principalId);
    const reader = yield* decodePrincipal(input.readerPrincipalId);
    const context = yield* input.shell.issueFixtureSetupGateway({
      audience: 'commerce-customer-context',
      legalEntityId: route.legalEntityId,
    });
    const result = yield* executeConfigureCustomerSourceRouteWithAuthorization(
      {
        _tag: 'CONFIGURE',
        expectedGeneration: Option.some(1),
        reason: 'INTERNAL_C14 the API-key integration principal reads current Group definitions before admission',
        route: {
          _tag: 'GROUP_DEFINITION',
          active: route.active,
          issuer: route.issuer,
          mappingRevision: route.mappingRevision,
          namespace: route.namespace,
          principalId: writer,
          route: { id: route.routeId, revision: route.routeRevision },
          sourceReaderPrincipalIds: [reader],
        },
      },
      `Bearer ${context.token}`,
      yield* customerFixtureUuid,
      {
        baseUrl: input.commerceBaseUrl,
        compositionRevision: input.compositionRevision,
        idempotencyKey: yield* customerFixtureUuid,
      },
    );
    return yield* Match.value(result).pipe(
      Match.tag('CONFIGURED', (configured) =>
        configured.generation === 2
          ? Effect.succeed(configured)
          : Effect.fail(refused(`CONFIGURED at generation ${configured.generation}`)),
      ),
      Match.tag('REJECTED', ({ reason }) => Effect.fail(refused(reason))),
      Match.orElse(({ _tag }) => Effect.fail(refused(_tag))),
    );
  },
);
