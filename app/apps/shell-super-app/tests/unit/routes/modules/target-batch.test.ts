// @rstest-environment happy-dom
import { pinTestDocument, testCompositionRevision } from '@app/shared-contracts/testing/http-double';
import { ConfigProvider, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  AuthenticatedSessionSchema,
  ResolvedModuleTargetSchema,
  ShellCapabilityUnavailableProblemSchema,
  ShellCompositionSchema,
  ShellTargetForbiddenProblemSchema,
} from '../../../../shared/browser-api.ts';
import { resetBrowserSessionCache } from '../../../../src/routes/[lang]/home-page-model.ts';
import { resetSessionScope } from '../../../../src/routes/session-scope.ts';
import { adaSignedIn, makeShellBff, signedInShellReads } from '../../../support/shell-bff-double.ts';
import type { ShellBffScript } from '../../../support/shell-bff-double.ts';

import {
  loadModulePageModel,
  prepareCanonicalTargets,
} from '../../../../src/routes/[lang]/modules/[moduleId]/module-page-model.ts';

const revision = testCompositionRevision;

const target = (page: string) =>
  Schema.decodeUnknownSync(ResolvedModuleTargetSchema)({
    appId: 'party-registry',
    componentKey: `party.registry.page-${page}`,
    compositionRevision: revision,
    entrypointKey: `party.registry.page.${page}`,
    federation: {
      expose: './PageContacts',
      manifest: { sha256: 'a'.repeat(64), url: 'https://assets.example.test/party/release-a/mf-manifest.json' },
      remoteName: 'partyRegistryReleaseA',
    },
    moduleId: 'party.registry',
    routeParameters: {},
    writable: true,
  });

const forbidden = Schema.decodeUnknownSync(ShellTargetForbiddenProblemSchema)({
  _tag: 'ShellTargetForbiddenProblem',
  detail: 'The requested module target is forbidden.',
  status: 403,
  title: 'Module target forbidden',
  type: 'https://ontos.dev/problems/module-target-forbidden',
});

const origin = 'https://shell.example.test';
const config = ConfigProvider.fromUnknown({});
/** A browser navigation or preload: no forwarded cookie, so targets use the browser's target cache. */
const browserModel = (canonicalPath: string) =>
  loadModulePageModel({ canonicalPath, request: new Request(`${origin}/en${canonicalPath}`) }).pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, config),
  );
const prepare = (canonicalPaths: readonly string[]) =>
  prepareCanonicalTargets(new Request(`${origin}/en${canonicalPaths[0] ?? ''}`), canonicalPaths).pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, config),
  );

const batchBff = (overrides: ShellBffScript = {}) =>
  makeShellBff({
    ...signedInShellReads(adaSignedIn),
    resolveModuleTarget: () => Effect.fail(forbidden),
    shellComposition: () =>
      Effect.succeed(
        Schema.decodeUnknownSync(ShellCompositionSchema)({
          compositionRevision: revision,
          deniedAppIds: [],
          gatewayAudiences: [],
          homeComponents: [],
          navigation: [],
          state: 'available',
          unavailableDeployments: [],
        }),
      ),
    ...overrides,
  });

const batches = (bff: ReturnType<typeof batchBff>) =>
  bff.requests.filter(({ endpoint }) => endpoint === 'resolveModuleTargets');
const singles = (bff: ReturnType<typeof batchBff>) =>
  bff.requests.filter(({ endpoint }) => endpoint === 'resolveModuleTarget');

it.live('resolves the menu targets in one request, so each destination loader finds its own target', () => {
  const bff = batchBff({
    resolveModuleTargets: () =>
      Effect.succeed({
        outcomes: [
          { state: 'resolved', target: target('batch-open') },
          { problem: forbidden, state: 'failed' },
        ],
      }),
  });
  return Effect.gen(function* batchesTargets() {
    yield* pinTestDocument;
    yield* resetSessionScope;
    yield* prepare(['/batch-open', '/batch-closed']);
    expect(batches(bff)).toHaveLength(1);
    expect(batches(bff)[0]?.body).toEqual({
      compositionRevision: revision,
      targets: [{ canonicalPath: '/batch-open' }, { canonicalPath: '/batch-closed' }],
    });

    expect(yield* browserModel('/batch-open')).toMatchObject({
      state: 'resolved',
      target: { entrypointKey: 'party.registry.page.batch-open' },
    });
    expect(singles(bff)).toHaveLength(0);
    // A failed target is not kept: its loader reads it alone and shows that read's own state.
    expect(yield* browserModel('/batch-closed')).toMatchObject({ state: 'forbidden' });
    expect(singles(bff)).toHaveLength(1);

    // Targets the browser already holds are not asked for again.
    yield* prepare(['/batch-open']);
    expect(batches(bff)).toHaveLength(1);
  }).pipe(Effect.provide(bff.browser));
});

it.live('keeps prepared targets to the company they were resolved for', () => {
  let session = adaSignedIn;
  const bff = batchBff({
    currentSession: () => Effect.succeed(session),
    resolveModuleTarget: () => Effect.succeed(target('other-company')),
    resolveModuleTargets: () => Effect.succeed({ outcomes: [{ state: 'resolved', target: target('company') }] }),
  });
  return Effect.gen(function* separatesContexts() {
    yield* pinTestDocument;
    yield* resetSessionScope;
    yield* prepare(['/company-only']);
    session = Schema.decodeUnknownSync(AuthenticatedSessionSchema)({
      ...adaSignedIn,
      identity: { ...adaSignedIn.identity, legalEntityId: '20000000-0000-4000-8000-000000000002' },
    });
    // Refresh the Shell session reads while retaining prepared targets for the previous company.
    yield* resetBrowserSessionCache;
    expect(yield* browserModel('/company-only')).toMatchObject({
      target: { entrypointKey: 'party.registry.page.other-company' },
    });
    expect(singles(bff)).toHaveLength(1);
  }).pipe(Effect.provide(bff.browser));
});

it.live('leaves every target to its own loader when the batch fails', () => {
  const unavailable = Schema.decodeUnknownSync(ShellCapabilityUnavailableProblemSchema)({
    ...forbidden,
    _tag: 'ShellCapabilityUnavailableProblem',
    retryable: true,
    status: 503,
  });
  const bff = batchBff({
    resolveModuleTarget: () => Effect.succeed(target('failed-batch')),
    resolveModuleTargets: () => Effect.fail(unavailable),
  });
  return Effect.gen(function* failedBatch() {
    yield* pinTestDocument;
    yield* resetSessionScope;
    expect(yield* Effect.flip(prepare(['/failed-batch']))).toEqual(unavailable);
    expect(yield* browserModel('/failed-batch')).toMatchObject({ state: 'resolved' });
    expect(singles(bff)).toHaveLength(1);
  }).pipe(Effect.provide(bff.browser));
});

it.live('does not ask before the company and its release are known', () => {
  const bff = batchBff({ currentSession: () => Effect.succeed({ state: 'anonymous' }) });
  return Effect.gen(function* anonymous() {
    yield* pinTestDocument;
    yield* resetSessionScope;
    yield* prepare(['/anonymous']);
    expect(batches(bff)).toHaveLength(0);
  }).pipe(Effect.provide(bff.browser));
});
