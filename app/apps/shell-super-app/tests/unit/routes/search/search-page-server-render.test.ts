// @rstest-environment node
// Server rendering of the search page as the SSR loader runs it on Node: there is no browser document. The Shell BFF
// double listens on a loopback port, and the loader reads the document context from the document's own origin there,
// with the visitor's cookie, as a development or test process without a configured render API does.
import { NodeHttpServer } from '@effect/platform-node';
import { Effect, Layer, Match, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { HttpRouter, HttpServer } from 'effect/http';

import { AvailableLegalEntitiesResponseSchema, ShellDocumentContextSchema } from '../../../../shared/browser-api.ts';
import type { ShellSearchPayload } from '../../../../shared/browser-api.ts';
import { loader } from '../../../../src/routes/[lang]/search/search-page-model.ts';
import { adaSignedIn, makeShellBff, shellCompositionRevision } from '../../../support/shell-bff-double.ts';

/** The document context the BFF answers server rendering with: Ada, signed in, one available composition. */
const signedInDocument = Schema.decodeUnknownSync(ShellDocumentContextSchema)({
  canManagePeople: false,
  composition: {
    compositionRevision: shellCompositionRevision,
    deniedAppIds: [],
    gatewayAudiences: [],
    homeComponents: [],
    navigation: [],
    state: 'available',
    unavailableDeployments: [],
  },
  home: { contribution: { state: 'forbidden' } },
  legalEntities: Schema.encodeSync(AvailableLegalEntitiesResponseSchema)(
    Schema.decodeUnknownSync(AvailableLegalEntitiesResponseSchema)({
      legalEntities: [{ legalEntityId: '20000000-0000-4000-8000-000000000001', legalName: 'Alpha company' }],
      selectedLegalEntityId: '20000000-0000-4000-8000-000000000001',
      state: 'authenticated',
      tenantContextAvailable: false,
    }),
  ),
  session: { identity: adaSignedIn.identity, state: 'authenticated' },
  tenants: { state: 'available', tenants: [] },
});

/** Every search payload the BFF received, in order. */
const searchPayloads: ShellSearchPayload[] = [];
const bff = makeShellBff({
  documentContext: () => Effect.succeed(signedInDocument),
  search: (payload) =>
    Effect.sync(() => {
      searchPayloads.push(payload);
      return { partial: false, results: [] };
    }),
});
const shellBffOnLoopback = HttpRouter.serve(bff.application, { disableListenLog: true, disableLogger: true }).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
);

it.layer(shellBffOnLoopback, { excludeTestServices: true })('search page server render', (suite) => {
  suite.effect('a server render returns the shell with the query pending and never runs the search', () =>
    Effect.gen(function* serverRenderSearch() {
      const { address } = yield* HttpServer.HttpServer;
      const port = yield* Match.value(address).pipe(
        Match.tag('InetAddressV4', 'InetAddressV6', ({ port: listening }) => Effect.succeed(listening)),
        Match.orElse(() => Effect.die(new Error('expected the BFF on a loopback TCP port'))),
      );
      const request = new Request(`http://127.0.0.1:${port}/en/search?q=Morava`, {
        headers: { cookie: 'better-auth.session_token=test-session' },
      });
      const model = yield* Effect.promise(() => loader({ request }));
      // The shell came from the BFF's document context, read with the visitor's cookie.
      expect(bff.requests.find(({ endpoint }) => endpoint === 'documentContext')?.cookie).toBe(
        'better-auth.session_token=test-session',
      );
      expect(searchPayloads).toEqual([]);
      expect(model).toMatchObject({ query: 'Morava', state: 'pending' });
      expect(model.shell.state).toBe('authenticated');
    }),
  );
});
