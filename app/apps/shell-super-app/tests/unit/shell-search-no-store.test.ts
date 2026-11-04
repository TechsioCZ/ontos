/* @rstest-environment node */

// Server HTTP checks need one native fetch realm; mixed DOM Response/native Headers silently drops headers.
import {
  ContextAccess,
  LegalEntityContext,
  ReadHandlerUnavailable,
  ReadInputValidationError,
  ReadPermissionDenied,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';
import { HttpApi, HttpApiBuilder, HttpApiGroup } from '@modern-js/bff-effect/effect-edge';
import { Effect, Layer, Schema } from 'effect';
import { HttpRouter, HttpServer, HttpServerResponse } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { AuthenticationService } from '../../api/auth/service.ts';
import type { ShellContextResult } from '../../api/auth/service.ts';
import { makeShellSearchNoStoreLayer, shellSearchHandler } from '../../api/index.ts';
import {
  makeInstalledModuleCatalogLoader,
  ShellInstalledModuleCatalog,
} from '../../api/modules/installed-module-catalog.ts';
import { ShellGovernedReads } from '../../api/modules/shell-governed-reads.ts';
import type { ShellGovernedReadsService } from '../../api/modules/shell-governed-reads.ts';
import { ShellAuthenticationApi } from '../../shared/api.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import { makeContextAccessDouble } from '../support/context-access-double.ts';
import { makeAuthenticationServiceDouble } from '../support/impersonation-service-doubles.ts';

const principal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authContextRef: 'session:search-no-store',
  authenticationNamespaceId: 'staff',
  authMethod: 'session',
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId: '10000000-0000-4000-8000-000000000001',
});
const company = { legalEntityId: principal.legalEntityId ?? '', legalName: 'Search company' };
const authenticated: ShellContextResult = {
  availableLegalEntities: [company],
  identity: {
    displayName: 'Search user',
    email: 'search@example.test',
    principalId: principal.principalId,
    tenantId: principal.tenantId,
    ...company,
  },
  principal,
  setCookieHeaders: [],
  state: 'authenticated',
};
const request = { headers: { cookie: 'session=search', 'x-correlation-id': 'search-no-store' } };

/** The Shell search endpoint is reused verbatim; only the response cache policy is under test. */
const searchHttpApi = HttpApi.make('searchNoStoreTest').add(
  HttpApiGroup.make('resources').add(ShellAuthenticationApi.groups.resources.endpoints.search),
);

const searchHttpResponse = Effect.fn('test.searchNoStoreResponse')(function* searchHttpResponse(
  search: ShellGovernedReadsService['search'],
  query = 'Eva',
  compositionRevision?: string,
) {
  const snapshot = yield* makeCompositionSnapshot([]);
  const catalog = yield* makeInstalledModuleCatalogLoader(Effect.succeed(snapshot));
  // Production composes the group handlers through Layer.provide, never by merging the global
  // middleware into the handler Layer (which widens the handler Layer's output with request markers).
  const handlers = HttpApiBuilder.group(searchHttpApi, 'resources', (builder) =>
    builder.handle('search', ({ payload, request: httpRequest }) => shellSearchHandler(httpRequest, payload)),
  ).pipe(Layer.provide(makeShellSearchNoStoreLayer()));
  const services = Layer.mergeAll(
    Layer.succeed(
      AuthenticationService,
      makeAuthenticationServiceDouble({ resolveShellContext: () => Effect.succeed(authenticated) }),
    ),
    Layer.succeed(ContextAccess, makeContextAccessDouble('allowed')),
    Layer.mock(LegalEntityContext, {}),
    Layer.succeed(ShellInstalledModuleCatalog, { load: Effect.succeed(catalog) }),
    Layer.mock(ShellGovernedReads, { search }),
  );
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        HttpApiBuilder.layer(searchHttpApi).pipe(
          Layer.provide(handlers),
          Layer.provideMerge(services),
          Layer.provide(HttpServer.layerServices),
        ),
        { disableLogger: true },
      ),
    ),
    (handler) => Effect.promise(() => handler.dispose()),
  );
  return yield* Effect.promise(() =>
    server.handler(
      new Request('https://shell.test/shell/search', {
        body: JSON.stringify({ compositionRevision: compositionRevision ?? catalog.composition.revision, query }),
        headers: { ...request.headers, 'content-type': 'application/json' },
        method: 'POST',
      }),
    ),
  );
});

it.effect('marks the encoded successful search response no-store', () =>
  Effect.gen(function* successfulSearchIsNotCacheable() {
    const response = yield* searchHttpResponse(() => Effect.succeed({ partial: false, results: [] }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
  }).pipe(Effect.scoped),
);

for (const [status, failure] of [
  [400, new ReadInputValidationError({ code: 'read_input_invalid', reason: 'Invalid selector' })],
  [403, new ReadPermissionDenied({ code: 'read_permission_denied', reason: 'Read denied' })],
  [503, new ReadHandlerUnavailable({ code: 'read_handler_unavailable', reason: 'Owner unavailable' })],
] as const) {
  it.effect(`marks the encoded search ${status} problem no-store`, () =>
    Effect.gen(function* failedSearchIsNotCacheable() {
      const response = yield* searchHttpResponse(() => Effect.fail(failure));
      expect(response.status).toBe(status);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('content-type')).toContain('application/problem+json');
    }).pipe(Effect.scoped),
  );
}

it.effect('marks a pre-handler payload validation problem no-store without invoking the owner', () =>
  Effect.gen(function* malformedSearchIsNotCacheable() {
    const response = yield* searchHttpResponse(
      () => Effect.die('Invalid payload reached search'),
      'Eva',
      'not-a-64-hex-revision',
    );
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
  }).pipe(Effect.scoped),
);

it.effect('leaves unrelated response cache policy unchanged', () =>
  Effect.gen(function* unrelatedResponseCacheControl() {
    const routes = HttpRouter.add(
      'POST',
      '/unrelated',
      HttpServerResponse.setHeader(HttpServerResponse.text('control'), 'cache-control', 'private, max-age=7'),
    ).pipe(Layer.provide(makeShellSearchNoStoreLayer()));
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
      (handler) => Effect.promise(() => handler.dispose()),
    );
    const response = yield* Effect.promise(() =>
      server.handler(new Request('https://shell.test/unrelated', { method: 'POST' })),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, max-age=7');
  }).pipe(Effect.scoped),
);
