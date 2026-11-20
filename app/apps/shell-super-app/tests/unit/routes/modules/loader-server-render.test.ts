// @rstest-environment node
import { ConfigProvider, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ResolvedModuleTargetSchema, ShellTargetForbiddenProblemSchema } from '../../../../shared/browser-api.ts';
import type { ShellDocumentContext, ShellDocumentTarget } from '../../../../shared/browser-api.ts';
import { loadModulePageModel } from '../../../../src/routes/[lang]/modules/[moduleId]/module-page-model.ts';
import { adaSignedIn, makeShellBff, shellCompositionRevision } from '../../../support/shell-bff-double.ts';

const approvedTarget = Schema.decodeUnknownSync(ResolvedModuleTargetSchema)({
  appId: 'party-registry',
  componentKey: 'party.registry.page-contacts',
  compositionRevision: shellCompositionRevision,
  entrypointKey: 'party.registry.page.contacts',
  federation: {
    expose: './PageContacts',
    manifest: { sha256: 'a'.repeat(64), url: 'https://assets.example.test/party/release-a/mf-manifest.json' },
    remoteName: 'partyRegistryReleaseA',
  },
  moduleId: 'party.registry',
  routeParameters: {},
  writable: false,
});

const problem = { detail: 'redacted', title: 'redacted', type: 'about:blank' } as const;
const targetForbidden = Schema.decodeUnknownSync(ShellTargetForbiddenProblemSchema)({
  ...problem,
  _tag: 'ShellTargetForbiddenProblem',
  status: 403,
});

/** The document context the BFF answers server rendering for Ada with the pinned composition. */
const signedInDocument = (target?: ShellDocumentTarget): ShellDocumentContext => {
  const document: ShellDocumentContext = {
    composition: {
      compositionRevision: shellCompositionRevision,
      deniedAppIds: [],
      gatewayAudiences: [],
      homeComponents: [],
      navigation: [],
      state: 'available',
      unavailableDeployments: [],
    },
    session: adaSignedIn,
  };
  return target === undefined ? document : { ...document, target };
};

/** Server rendering of /contacts for a visitor who carries the Shell's session cookie. */
const serverModel = (context: ShellDocumentContext) => {
  const bff = makeShellBff({ documentContext: () => Effect.succeed(context) });
  const serverRequest = new Request('https://shell.example.test/en/contacts', {
    headers: { cookie: 'better-auth.session_token=test-session' },
  });
  return loadModulePageModel({ canonicalPath: '/contacts', request: serverRequest }).pipe(
    Effect.provide(bff.layer),
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
    Effect.map((model) => ({ model, requests: bff.requests.map(({ body, endpoint }) => ({ body, endpoint })) })),
  );
};

it.effect('server rendering reads the page target in the one document read and keeps it only for that revision', () =>
  Effect.gen(function* serverTargetInDocument() {
    const resolved = yield* serverModel(signedInDocument({ state: 'resolved', target: approvedTarget }));
    expect(resolved.model).toMatchObject({ state: 'resolved', target: { moduleId: 'party.registry' } });
    // One request per document: no separate target read, no separate Shell read.
    expect(resolved.requests).toEqual([
      { body: { target: { canonicalPath: '/contacts' } }, endpoint: 'documentContext' },
    ]);

    const promoted = signedInDocument({
      state: 'resolved',
      target: { ...approvedTarget, compositionRevision: 'd'.repeat(64) },
    });
    expect((yield* serverModel(promoted)).model).toMatchObject({ state: 'reload_required' });
    const forbidden = signedInDocument({ problem: targetForbidden, state: 'failed' });
    expect((yield* serverModel(forbidden)).model).toMatchObject({ state: 'forbidden' });
    const sessionEnded = signedInDocument({
      problem: { ...problem, _tag: 'ShellAuthenticationRequiredProblem', status: 401 },
      state: 'failed',
    });
    expect((yield* serverModel(sessionEnded)).model).toMatchObject({
      shell: { reason: 'session_ended' },
      state: 'selection_required',
    });
    const unselected = signedInDocument({ state: 'selection_required' });
    expect((yield* serverModel(unselected)).model).toMatchObject({ state: 'selection_required' });
    // An authenticated document that answered no target never shows a page.
    expect((yield* serverModel(signedInDocument())).model).toMatchObject({ state: 'unavailable' });
    const anonymous = yield* serverModel({ session: { state: 'anonymous' } });
    expect(anonymous.model).toMatchObject({ state: 'selection_required' });
    expect(anonymous.requests.map(({ endpoint }) => endpoint)).toEqual(['documentContext']);
  }),
);
