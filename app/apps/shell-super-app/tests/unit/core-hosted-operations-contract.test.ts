import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Path, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ModuleOperationRouteSchema } from '@app/core-runtime/sdk';
import { coreOperations } from '@app/core-runtime/sdk/core';

import { ShellAuthenticationApi } from '../../shared/browser-api.ts';

/*
 * The Shell endpoint that hosts Core Media Current V1 for a module (#1443 P2): one POST, the Core operation's own
 * schemas, only Bearer problems (no session), and a source that never reads a cookie or resolves a session.
 */

const { coreHostedOperations: group } = ShellAuthenticationApi.groups;
const { assetCurrent: endpoint } = group.endpoints;
const coreOperationRequest = Schema.toEncoded(coreOperations.assetCurrent.request);
const verticalRef = {
  moduleId: 'commerce.catalog',
  resourceId: '11111111-1111-4111-8111-111111111111',
  resourceType: 'commerce.catalog.product',
  tenantId: '22222222-2222-4222-8222-222222222222',
};

const readApp = Effect.fn('CoreHostedOperationsContract.read')(function* readApp(relative: string) {
  const [fileSystem, path] = yield* Effect.all([FileSystem.FileSystem, Path.Path], { concurrency: 2 });
  return yield* fileSystem.readFileString(yield* path.fromFileUrl(new URL(`../../${relative}`, import.meta.url)));
});

/** Comments describe what is excluded; only code can contain a forbidden concept. */
const codeOf = (text: string): string =>
  text
    .replaceAll(/\/\*[\s\S]*?\*\//gu, '')
    .replaceAll(/^\s*\/\/.*$/gmu, '')
    .replaceAll(/\s\/\/.*$/gmu, '');

const statusOf = (schema: Schema.Top): number => Number(Schema.resolveAnnotationsKey(schema)?.httpApiStatus);

it('publishes exactly one endpoint, at the very path of the operation reference, with the operation schemas', () => {
  expect(Object.keys(group.endpoints)).toEqual(['assetCurrent']);
  expect(endpoint.method).toBe('POST');
  expect(Schema.is(ModuleOperationRouteSchema)(coreOperations.assetCurrent.route)).toBe(true);
  expect(Schema.is(Schema.Struct({ path: Schema.Literal(endpoint.path) }))(coreOperations.assetCurrent.route)).toBe(
    true,
  );
  // Only owner-qualified Core Media refs in a non-empty set: a vertical's ref or an empty set never decodes.
  expect(Schema.is(coreOperationRequest)({ mediaAssetRefs: [] })).toBe(false);
  expect(Schema.is(coreOperationRequest)({ mediaAssetRefs: [verticalRef] })).toBe(false);
});

it('answers only the sanitized governed-read problem statuses, with no redirect or partial transport', () => {
  const statuses = [...endpoint.error].map(statusOf).toSorted((left, right) => left - right);
  expect(statuses).toEqual([400, 401, 403, 404, 409, 422, 500, 503]);
});

it.layer(NodeServices.layer, { excludeTestServices: true })('the Shell sources of the hosted operation', (suite) => {
  suite.effect('authenticate only a Bearer assertion: no cookie, no session and no tenant taken from the request', () =>
    Effect.gen(function* bearerOnly() {
      const hosted = codeOf(yield* readApp('api/core-hosted-operations.ts'));
      expect(hosted).not.toMatch(/resolveTenantContext|cookie|setCookie|session/iu);
      // The principal comes from the verified assertion; the audience is the Shell app id, never a request value.
      expect(hosted).toContain('bindGatewayPrincipalVerifier(SHELL_HOST_APP_ID');
      expect(hosted).toContain('verifyAndRedeem');
      const index = codeOf(yield* readApp('api/index.ts'));
      const start = index.indexOf("HttpApiBuilder.group(ShellAuthenticationApi, 'coreHostedOperations'");
      const end = index.indexOf('const coreMediaObjectStorageLive');
      expect(start).toBeGreaterThan(0);
      const handler = index.slice(start, end);
      expect(handler).toContain('authenticatePrincipal: authenticateHostedOperation');
      expect(handler).toContain('registration: assetCurrentRead');
      expect(handler).not.toMatch(/resolveTenantContext|AuthenticationService|cookie/iu);
    }),
  );

  suite.effect('keep the session routes free of any Bearer assertion reader', () =>
    Effect.gen(function* sessionRoutesUntouched() {
      const index = codeOf(yield* readApp('api/index.ts'));
      // The verifier is bound once, in the hosted-operation module: no other Shell route reads a delegated assertion.
      expect(index).not.toContain('bindGatewayPrincipalVerifier');
      expect(index.match(/authenticateHostedOperation/gu)?.length).toBe(2);
    }),
  );
});
