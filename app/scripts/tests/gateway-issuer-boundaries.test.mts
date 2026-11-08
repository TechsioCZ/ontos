import { readFileSync } from 'node:fs';
import { Cause, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { gatewayContextAuthorizationEntrypoints } from '../../packages/shared-contracts/src/gateway-context.ts';
import {
  validateGatewayIssuerEntrypoints,
  validateGatewayIssuerSources,
} from '../check-module-entrypoint-boundaries.mts';

const GATEWAY_FILE = 'packages/shared-contracts/src/gateway-context.ts';
const API_FILE = 'apps/shell-super-app/shared/api.ts';
const DOCUMENT_FILE = 'apps/shell-super-app/shared/document-gateway-api.ts';
const RUNTIME_FILE = 'apps/shell-super-app/api/index.ts';
const actualSources = new Map(
  [GATEWAY_FILE, API_FILE, DOCUMENT_FILE, RUNTIME_FILE].map(
    (file) => [file, readFileSync(new URL(`../../${file}`, import.meta.url), 'utf-8')] as const,
  ),
);

const changedSources = (file: string, before: string, after: string, appended = '') => {
  const source = actualSources.get(file);
  if (source === undefined || !source.includes(before)) {
    throw new Error(`Gateway rejection control no longer matches ${file}: ${before}`);
  }
  return new Map([...actualSources, [file, source.replace(before, after) + appended]]);
};

const rejects = <Success, Failure>(effect: Effect.Effect<Success, Failure>, message: RegExp) =>
  Effect.matchCause(effect, {
    onFailure: (cause) => expect(String(Cause.squash(cause))).toMatch(message),
    onSuccess: () => {
      throw new Error('Expected gateway boundary rejection');
    },
  });

it.effect('accepts all six canonical issuer classifications in reverse order', () =>
  validateGatewayIssuerEntrypoints(gatewayContextAuthorizationEntrypoints.toReversed()),
);

it.effect('accepts the real three gateway groups and six handlers mounted by the production Shell runtime', () =>
  validateGatewayIssuerSources(actualSources),
);

const IssuerMutationSchema = Schema.Literals([
  'missing',
  'duplicate',
  'unknown',
  'credential',
  'kind',
  'path',
  'owner',
  'deployment',
  'surface',
]);
type GatewayIssuer = Parameters<typeof validateGatewayIssuerEntrypoints>[0][number];

for (const issuer of gatewayContextAuthorizationEntrypoints) {
  for (const field of IssuerMutationSchema.literals) {
    it.effect(`keeps the closed issuer inventory exact for ${issuer.entrypointKey}: ${field}`, () => {
      const changed = gatewayContextAuthorizationEntrypoints.flatMap<GatewayIssuer>((candidate) => {
        if (candidate.entrypointKey !== issuer.entrypointKey) {
          return [candidate];
        }
        const mutations = {
          credential: [
            {
              ...candidate,
              authorization: {
                credential: candidate.authorization.credential === 'session' ? 'api_key' : 'session',
                kind: 'capability_issuance',
              },
            },
          ],
          deployment: [{ ...candidate, deployment: 'foreign-deployment' }],
          duplicate: [candidate, candidate],
          kind: [{ ...candidate, authorization: { kind: 'public' } }],
          missing: [],
          owner: [{ ...candidate, owner: 'foreign-owner' }],
          path: [{ ...candidate, path: '/shell-super-app-api/unclassified' }],
          surface: [{ ...candidate, surface: 'route' }],
          unknown: [{ ...candidate, entrypointKey: 'shell.unknown.issue.session' }],
        } satisfies Readonly<Record<typeof IssuerMutationSchema.Type, readonly GatewayIssuer[]>>;
        return mutations[field];
      });
      return rejects(validateGatewayIssuerEntrypoints(changed), /must classify exactly/u);
    });
  }
}

const routes = [
  { file: GATEWAY_FILE, handler: 'issueGatewayContext', path: '/auth/gateway-context' },
  { file: GATEWAY_FILE, handler: 'issueApiKeyGatewayContext', path: '/auth/api-key/gateway-context' },
  { file: GATEWAY_FILE, handler: 'issueDelegatedGatewayContext', path: '/auth/delegated/gateway-context' },
  { file: GATEWAY_FILE, handler: 'readWithApiKeyGatewayContext', path: '/auth/api-key/gateway-read' },
  { file: DOCUMENT_FILE, handler: 'issueDocumentGatewayContexts', path: '/auth/gateway-contexts' },
  { file: API_FILE, handler: 'documentContext', path: '/shell/document-context' },
] as const;

for (const route of routes) {
  for (const mutation of ['method', 'name', 'path'] as const) {
    it.effect(`rejects a changed original endpoint for ${route.handler}: ${mutation}`, () => {
      const before = `HttpApiEndpoint.post('${route.handler}', '${route.path}',`;
      const after = {
        method: `HttpApiEndpoint.get('${route.handler}', '${route.path}',`,
        name: `HttpApiEndpoint.post('unmounted', '${route.path}',`,
        path: `HttpApiEndpoint.post('${route.handler}', '/wrong-path',`,
      }[mutation];
      return rejects(
        validateGatewayIssuerSources(changedSources(route.file, before, after, `\n// ${before}\n`)),
        /mounted gateway contract/u,
      );
    });
  }

  it.effect(`rejects an unmounted handler even with a separate name-presence decoy: ${route.handler}`, () =>
    rejects(
      validateGatewayIssuerSources(
        changedSources(
          RUNTIME_FILE,
          `.handle('${route.handler}',`,
          ".handle('unmounted',",
          `\nconst decoy = handlers.handle('${route.handler}', () => Effect.void);\n// .handle('${route.handler}', unused)\n`,
        ),
      ),
      /all six classified capability issuers/u,
    ),
  );
}

const groups = [
  { file: GATEWAY_FILE, id: 'gatewayContext', layer: 'gatewayContextGroupLive', name: 'GatewayContextApiGroup' },
  { file: DOCUMENT_FILE, id: 'documentGateway', layer: 'documentGatewayGroupLive', name: 'DocumentGatewayApiGroup' },
  { file: API_FILE, id: 'documentContext', layer: 'documentContextGroupLive', name: 'ShellDocumentContextApiGroup' },
] as const;

for (const group of groups) {
  it.effect(`requires the original mounted group, not an unused add: ${group.name}`, () =>
    rejects(
      validateGatewayIssuerSources(
        changedSources(
          API_FILE,
          `.add(${group.name})`,
          '.add(UnrelatedApiGroup)',
          `\nconst decoy = unrelatedApi.add(${group.name});\n`,
        ),
      ),
      /mounted gateway contract/u,
    ),
  );

  it.effect(`requires the exact group identity: ${group.name}`, () =>
    rejects(
      validateGatewayIssuerSources(
        changedSources(group.file, `HttpApiGroup.make('${group.id}')`, "HttpApiGroup.make('unrelated')"),
      ),
      /mounted gateway contract/u,
    ),
  );

  it.effect(`requires the receiving group identity: ${group.id}`, () =>
    rejects(
      validateGatewayIssuerSources(
        changedSources(
          RUNTIME_FILE,
          `HttpApiBuilder.group(ShellAuthenticationApi, '${group.id}',`,
          "HttpApiBuilder.group(ShellAuthenticationApi, 'unrelated',",
        ),
      ),
      /all six classified capability issuers/u,
    ),
  );

  it.effect(`requires the real receiving API rather than a decoy API: ${group.id}`, () =>
    rejects(
      validateGatewayIssuerSources(
        changedSources(
          RUNTIME_FILE,
          `HttpApiBuilder.group(ShellAuthenticationApi, '${group.id}',`,
          `HttpApiBuilder.group(UnrelatedApi, '${group.id}',`,
        ),
      ),
      /all six classified capability issuers/u,
    ),
  );

  it.effect(`requires the handler layer in the assembled runtime: ${group.layer}`, () =>
    rejects(
      validateGatewayIssuerSources(
        changedSources(
          RUNTIME_FILE,
          `    ${group.layer},`,
          '    unrelatedGroupLive,',
          `\nconst decoyMerge = Layer.mergeAll(${group.layer});\n`,
        ),
      ),
      /all six classified capability issuers/u,
    ),
  );
}

for (const [file, before, after] of [
  [API_FILE, "from '@app/shared-contracts';", "from './decoy-gateway.ts';"],
  [API_FILE, "from './document-gateway-api.ts';", "from './decoy-document.ts';"],
  [RUNTIME_FILE, "from '../shared/api.ts';", "from './decoy-api.ts';"],
  [RUNTIME_FILE, '    handlers: apiHandlersLive,', '    handlers: unrelatedHandlers,'],
  [RUNTIME_FILE, '    api: ShellAuthenticationApi,', '    api: UnrelatedApi,'],
  [RUNTIME_FILE, 'export default apiRuntime;', 'export default unrelatedRuntime;'],
  [RUNTIME_FILE, '  return assembleEffectBffRuntime({', '  return decoyAssembler({'],
  [RUNTIME_FILE, '  const apiHandlersLive = Layer.mergeAll(', '  const apiHandlersLive = unrelatedMerge('],
  [
    RUNTIME_FILE,
    '    handlers: apiHandlersLive,',
    '    handlers: apiHandlersLive, ...{ handlers: unrelatedHandlers },',
  ],
  [
    RUNTIME_FILE,
    ').pipe(Layer.provide(apiServicesLive), Layer.provide(shellSearchNoStoreLayer));',
    ').pipe(() => unrelatedHandlers);',
  ],
] as const) {
  it.effect(`rejects disconnected issuer contract or runtime wiring: ${before}`, () =>
    rejects(
      validateGatewayIssuerSources(changedSources(file, before, after)),
      /mounted gateway contract|all six classified capability issuers/u,
    ),
  );
}

it.effect('rejects an extra unclassified issuer endpoint in the original gateway group', () =>
  rejects(
    validateGatewayIssuerSources(
      changedSources(
        GATEWAY_FILE,
        "export const GatewayContextApiGroup = HttpApiGroup.make('gatewayContext')",
        "export const GatewayContextApiGroup = HttpApiGroup.make('gatewayContext').add(HttpApiEndpoint.post('unknownIssuer', '/auth/unknown', {}))",
      ),
    ),
    /mounted gateway contract/u,
  ),
);

it.effect('rejects a duplicate original endpoint rather than counting names alone', () =>
  rejects(
    validateGatewayIssuerSources(
      changedSources(
        DOCUMENT_FILE,
        "HttpApiGroup.make('documentGateway')",
        "HttpApiGroup.make('documentGateway').add(HttpApiEndpoint.post('issueDocumentGatewayContexts', '/auth/gateway-contexts', {}))",
      ),
    ),
    /mounted gateway contract/u,
  ),
);
