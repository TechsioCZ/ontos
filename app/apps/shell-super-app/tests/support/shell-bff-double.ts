import { HttpApi, HttpApiGroup } from '@modern-js/bff-effect/effect-client';
import type { HttpApiEndpoint } from '@modern-js/bff-effect/effect-client';
import { HttpApiBuilder, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { Effect, Layer, Schema } from 'effect';

import {
  accessAdminApprovalsGroup,
  accessAdminChangesGroup,
  accessAdminExplainGroup,
  accessAdminPeopleGroup,
  accessAdminRolesGroup,
} from '../../shared/access-admin-api.ts';
import {
  AuthenticatedSessionSchema,
  AvailableLegalEntitiesResponseSchema,
  AvailableTenantsResponseSchema,
  SelectionRequiredSessionSchema,
  ShellCompositionSchema,
  ShellAuthenticationApi,
  shellAuthenticationApiContract,
  ShellDocumentContextApiGroup,
} from '../../shared/browser-api.ts';
import type { CurrentSession } from '../../shared/browser-api.ts';
import { moduleTargetSourceHeader } from '../../shared/module-target-diagnostics.ts';
import { browserNetwork, inProcessFetch } from '@app/shared-contracts/testing/http-double';

const contract = ShellAuthenticationApi.groups;

/** The Shell BFF groups the shell pages and access administration call, mounted where the client sends them. */
const ShellBffDoubleApi = HttpApi.make('shellBffDouble')
  .add(contract.authentication)
  .add(HttpApiGroup.make('identity').add(contract.identity.endpoints.demoAccountCapability))
  .add(contract.coreReadLegalEntityDetail)
  .add(contract.composition)
  .add(contract.legalEntities)
  .add(contract.tenants)
  .add(contract.resources)
  .add(ShellDocumentContextApiGroup)
  .add(accessAdminRolesGroup)
  .add(HttpApiGroup.make('accessAdminPeople').add(accessAdminPeopleGroup.endpoints.listAccessPeople))
  .add(accessAdminChangesGroup)
  .add(accessAdminApprovalsGroup)
  .add(accessAdminExplainGroup)
  .prefix(shellAuthenticationApiContract.apiPrefix);

type DoubleEndpoint =
  typeof ShellBffDoubleApi extends HttpApi.HttpApi<string, infer Groups> ? HttpApiGroup.Endpoints<Groups> : never;

/** A Shell BFF endpoint, named as the BFF names it. */
export type ShellBffEndpoint = DoubleEndpoint['identifier'];

type Endpoint<Name extends ShellBffEndpoint> = HttpApiEndpoint.WithIdentifier<DoubleEndpoint, Name>;

type PayloadOf<Name extends ShellBffEndpoint> = HttpApiEndpoint.Payload<Endpoint<Name>>['Type'];
type QueryOf<Name extends ShellBffEndpoint> = HttpApiEndpoint.Query<Endpoint<Name>>['Type'];

/** What one request to the endpoint carries: its decoded payload, its query, or nothing at all. */
type EndpointInput<Name extends ShellBffEndpoint> = [PayloadOf<Name>] extends [never]
  ? [QueryOf<Name>] extends [never]
    ? undefined
    : QueryOf<Name>
  : PayloadOf<Name>;

/** What the BFF answers on the endpoint: its declared success or one of its declared Problem Details. */
type Answer<Name extends ShellBffEndpoint> = Effect.Effect<
  HttpApiEndpoint.SuccessWithIdentifier<DoubleEndpoint, Name>,
  HttpApiEndpoint.ErrorsWithIdentifier<DoubleEndpoint, Name>
>;

/**
 * The Shell BFF endpoints a test scripts. An endpoint a test does not script answers with a
 * defect, so an unexpected request fails the test instead of passing silently.
 */
export type ShellBffScript = {
  readonly [Name in ShellBffEndpoint]?: (input: EndpointInput<Name>) => Answer<Name>;
};

/** One request as the BFF received it: the decoded input, the URL and the headers the browser client set. */
export interface ShellBffRequest {
  readonly acceptLanguage: string | undefined;
  readonly body: { readonly [Name in ShellBffEndpoint]: EndpointInput<Name> }[ShellBffEndpoint];
  readonly cookie: string | undefined;
  readonly endpoint: ShellBffEndpoint;
  readonly idempotencyKey: string | undefined;
  /** Why the Shell asked for a module target (`x-ontos-target-source`), when it said. */
  readonly targetSource: string | undefined;
  readonly url: string;
}

/** The composition revision every signed-in shell read pins, the same one the route fixtures carry. */
export const shellCompositionRevision = '1'.repeat(64);

/** Ada, signed in with her Alpha company selected. */
export const adaSignedIn = Schema.decodeUnknownSync(AuthenticatedSessionSchema)({
  identity: {
    displayName: 'Ada Lovelace',
    email: 'ada@example.test',
    legalEntityId: '20000000-0000-4000-8000-000000000001',
    legalName: 'Alpha company',
    principalId: 'principal-1',
    tenantId: 'tenant-1',
  },
  state: 'authenticated',
});

/** Ada, signed in to her Tenant with no company selected yet. */
export const adaSelectingCompany = Schema.decodeUnknownSync(SelectionRequiredSessionSchema)({
  availableLegalEntities: [{ legalEntityId: '20000000-0000-4000-8000-000000000001', legalName: 'Alpha company' }],
  identity: {
    displayName: 'Ada Lovelace',
    email: 'ada@example.test',
    principalId: 'principal-1',
    tenantId: 'tenant-1',
  },
  state: 'selection_required',
});

/**
 * The BFF reads `loadHomePageModel` makes for a signed-in session: the session itself, the
 * composition it pins, and no further company or tenant choices.
 */
export const signedInShellReads = (session: CurrentSession) =>
  ({
    availableLegalEntities: () =>
      Effect.succeed(
        Schema.decodeUnknownSync(AvailableLegalEntitiesResponseSchema)({
          legalEntities: [],
          state: 'authenticated',
          tenantContextAvailable: false,
        }),
      ),
    availableTenants: () => Effect.succeed(Schema.decodeUnknownSync(AvailableTenantsResponseSchema)({ tenants: [] })),
    currentSession: () => Effect.succeed(session),
    demoAccountCapability: () => Effect.succeed({ canManage: false }),
    shellComposition: () =>
      Effect.succeed(
        Schema.decodeUnknownSync(ShellCompositionSchema)({
          compositionRevision: shellCompositionRevision,
          deniedAppIds: [],
          gatewayAudiences: [],
          homeComponents: [],
          navigation: [],
          state: 'available',
          unavailableDeployments: [],
        }),
      ),
  }) satisfies ShellBffScript;

/**
 * A scriptable Shell BFF served in process as the browser client's transport. Requests are decoded
 * and answers encoded by the real endpoint schemas; `requests` records what the client sent, in order.
 */
export const makeShellBff = (script: ShellBffScript) => {
  const requests: ShellBffRequest[] = [];
  const answer = <Name extends ShellBffEndpoint>(
    endpoint: Name,
    input: EndpointInput<Name>,
    request: { readonly headers: Readonly<Record<string, string | undefined>>; readonly originalUrl: string },
    scripted: ((input: EndpointInput<Name>) => Answer<Name>) | undefined,
  ): Answer<Name> =>
    Effect.suspend(() => {
      const received: ShellBffRequest = {
        acceptLanguage: request.headers['accept-language'],
        body: input,
        cookie: request.headers['cookie'],
        endpoint,
        idempotencyKey: request.headers['idempotency-key'],
        targetSource: request.headers[moduleTargetSourceHeader],
        url: request.originalUrl,
      };
      requests.push(received);
      return scripted === undefined
        ? Effect.die(`The Shell BFF double has no answer for ${endpoint}`)
        : scripted(input);
    });
  const handlers = Layer.mergeAll(
    HttpApiBuilder.group(ShellBffDoubleApi, 'authentication', (group) =>
      group
        .handle('signIn', ({ payload, request }) => answer('signIn', payload, request, script.signIn))
        .handle('currentSession', ({ request }) => answer('currentSession', undefined, request, script.currentSession))
        .handle('signOut', ({ request }) => answer('signOut', undefined, request, script.signOut)),
    ),
    HttpApiBuilder.group(ShellBffDoubleApi, 'identity', (group) =>
      group.handle('demoAccountCapability', ({ payload, request }) =>
        answer('demoAccountCapability', payload, request, script.demoAccountCapability),
      ),
    ),
    HttpApiBuilder.group(ShellBffDoubleApi, 'coreReadLegalEntityDetail', (group) =>
      group.handle('executeLegalEntityDetail', ({ payload, request }) =>
        answer('executeLegalEntityDetail', payload, request, script.executeLegalEntityDetail),
      ),
    ),
    HttpApiBuilder.group(ShellBffDoubleApi, 'composition', (group) =>
      group
        .handle('shellComposition', ({ query, request }) =>
          answer('shellComposition', query, request, script.shellComposition),
        )
        .handle('resolveModuleTarget', ({ payload, request }) =>
          answer('resolveModuleTarget', payload, request, script.resolveModuleTarget),
        )
        .handle('resolveModuleTargets', ({ payload, request }) =>
          answer('resolveModuleTargets', payload, request, script.resolveModuleTargets),
        ),
    ),
    HttpApiBuilder.group(ShellBffDoubleApi, 'documentContext', (group) =>
      group.handle('documentContext', ({ payload, request }) =>
        answer('documentContext', payload, request, script.documentContext),
      ),
    ),
    HttpApiBuilder.group(ShellBffDoubleApi, 'legalEntities', (group) =>
      group
        .handle('availableLegalEntities', ({ request }) =>
          answer('availableLegalEntities', undefined, request, script.availableLegalEntities),
        )
        .handle('switchToTenantContext', ({ request }) =>
          answer('switchToTenantContext', undefined, request, script.switchToTenantContext),
        )
        .handle('switchLegalEntity', ({ payload, request }) =>
          answer('switchLegalEntity', payload, request, script.switchLegalEntity),
        ),
    ),
    HttpApiBuilder.group(ShellBffDoubleApi, 'tenants', (group) =>
      group
        .handle('availableTenants', ({ request }) =>
          answer('availableTenants', undefined, request, script.availableTenants),
        )
        .handle('switchTenant', ({ payload, request }) =>
          answer('switchTenant', payload, request, script.switchTenant),
        ),
    ),
    HttpApiBuilder.group(ShellBffDoubleApi, 'resources', (group) =>
      group
        .handle('search', ({ payload, request }) => answer('search', payload, request, script.search))
        .handle('resourceDetail', ({ payload, request }) =>
          answer('resourceDetail', payload, request, script.resourceDetail),
        )
        .handle('attachMedia', ({ payload, request }) => answer('attachMedia', payload, request, script.attachMedia)),
    ),
    HttpApiBuilder.group(ShellBffDoubleApi, 'accessAdminRoles', (group) =>
      group
        .handle('listAccessRoles', ({ payload, request }) =>
          answer('listAccessRoles', payload, request, script.listAccessRoles),
        )
        .handle('getAccessRole', ({ payload, request }) =>
          answer('getAccessRole', payload, request, script.getAccessRole),
        )
        .handle('listAccessRoleTemplates', ({ payload, request }) =>
          answer('listAccessRoleTemplates', payload, request, script.listAccessRoleTemplates),
        )
        .handle('previewAccessRoleEdit', ({ payload, request }) =>
          answer('previewAccessRoleEdit', payload, request, script.previewAccessRoleEdit),
        )
        .handle('saveAccessRoleEdit', ({ payload, request }) =>
          answer('saveAccessRoleEdit', payload, request, script.saveAccessRoleEdit),
        )
        .handle('createAccessRole', ({ payload, request }) =>
          answer('createAccessRole', payload, request, script.createAccessRole),
        ),
    ),
    HttpApiBuilder.group(ShellBffDoubleApi, 'accessAdminPeople', (group) =>
      group.handle('listAccessPeople', ({ payload, request }) =>
        answer('listAccessPeople', payload, request, script.listAccessPeople),
      ),
    ),
    HttpApiBuilder.group(ShellBffDoubleApi, 'accessAdminChanges', (group) =>
      group
        .handle('listAccessChanges', ({ payload, request }) =>
          answer('listAccessChanges', payload, request, script.listAccessChanges),
        )
        .handle('previewAccessChanges', ({ payload, request }) =>
          answer('previewAccessChanges', payload, request, script.previewAccessChanges),
        )
        .handle('decideAccessChanges', ({ payload, request }) =>
          answer('decideAccessChanges', payload, request, script.decideAccessChanges),
        ),
    ),
    HttpApiBuilder.group(ShellBffDoubleApi, 'accessAdminApprovals', (group) =>
      group
        .handle('listAccessApprovals', ({ payload, request }) =>
          answer('listAccessApprovals', payload, request, script.listAccessApprovals),
        )
        .handle('decideAccessApproval', ({ payload, request }) =>
          answer('decideAccessApproval', payload, request, script.decideAccessApproval),
        )
        .handle('executeAccessApproval', ({ payload, request }) =>
          answer('executeAccessApproval', payload, request, script.executeAccessApproval),
        ),
    ),
    HttpApiBuilder.group(ShellBffDoubleApi, 'accessAdminExplain', (group) =>
      group.handle('explainAccess', ({ payload, request }) =>
        answer('explainAccess', payload, request, script.explainAccess),
      ),
    ),
  );
  const application = HttpApiBuilder.layer(ShellBffDoubleApi).pipe(
    Layer.provide(handlers),
    Layer.provide(HttpServer.layerServices),
  );
  return {
    /** The BFF as one in-process application, for a test that serves it itself (a loopback server rendering reads). */
    application,
    /** Serves the page's own browser-runtime requests through the test DOM's network. */
    browser: browserNetwork(application),
    /** Serves the client Effects a test runs itself, through `FetchHttpClient.Fetch`. */
    layer: inProcessFetch(application),
    requests,
  } as const;
};
