import { ConfigProvider, Effect } from 'effect';
import { beforeEach, expect, rstest, it } from 'effect-rstest';

import {
  loadModulePageModel,
  prepareCanonicalTargets,
} from '../../../../src/routes/[lang]/modules/[moduleId]/module-page-model.ts';

const { loadHomePageModelMock, resolveModuleTargetMock, resolveModuleTargetsMock } = rstest.hoisted(() => ({
  loadHomePageModelMock: rstest.fn(),
  resolveModuleTargetMock: rstest.fn(),
  resolveModuleTargetsMock: rstest.fn(),
}));

rstest.mock('../../../../src/api/auth-client.ts', () => ({
  resolveModuleTarget: resolveModuleTargetMock,
  resolveModuleTargets: resolveModuleTargetsMock,
}));

rstest.mock('../../../../src/routes/[lang]/home-page-model.ts', () => ({
  loadHomePageModel: loadHomePageModelMock,
}));

const revision = 'c'.repeat(64);
const shell = (legalEntityId: string) => ({
  compositionRevision: revision,
  contextState: 'authenticated' as const,
  identity: {
    displayName: 'Ada Lovelace',
    email: 'ada@example.test',
    legalEntityId,
    legalName: 'Alpha company',
    principalId: 'principal-1',
    tenantId: 'tenant-1',
  },
  legalEntities: { items: [], state: 'available' as const },
  navigation: { items: [], state: 'available' as const },
  selectedLegalEntityId: legalEntityId,
  state: 'authenticated' as const,
  tenants: { items: [], state: 'available' as const },
});

const target = (page: string) => ({
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

const forbidden = {
  _tag: 'ShellTargetForbiddenProblem' as const,
  detail: 'The requested module target is forbidden.',
  status: 403 as const,
  title: 'Module target forbidden',
  type: 'https://ontos.dev/problems/module-target-forbidden',
};

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

beforeEach(() => {
  loadHomePageModelMock.mockReturnValue(Effect.succeed(shell('legal-1')));
  resolveModuleTargetMock.mockReturnValue(Effect.fail(forbidden));
});

it.effect('resolves the menu targets in one request, so each destination loader finds its own target', () =>
  Effect.gen(function* batchesTargets() {
    resolveModuleTargetsMock.mockReturnValueOnce(
      Effect.succeed({
        outcomes: [
          { state: 'resolved', target: target('batch-open') },
          { problem: forbidden, state: 'failed' },
        ],
      }),
    );
    yield* prepare(['/batch-open', '/batch-closed']);
    expect(resolveModuleTargetsMock).toHaveBeenCalledTimes(1);
    expect(resolveModuleTargetsMock.mock.calls[0]?.[0]).toEqual({
      compositionRevision: revision,
      targets: [{ canonicalPath: '/batch-open' }, { canonicalPath: '/batch-closed' }],
    });

    expect(yield* browserModel('/batch-open')).toMatchObject({
      state: 'resolved',
      target: { entrypointKey: 'party.registry.page.batch-open' },
    });
    expect(resolveModuleTargetMock).not.toHaveBeenCalled();
    // A failed target is not kept: its loader reads it alone and shows that read's own state.
    expect(yield* browserModel('/batch-closed')).toMatchObject({ state: 'forbidden' });
    expect(resolveModuleTargetMock).toHaveBeenCalledTimes(1);

    // Targets the browser already holds are not asked for again.
    yield* prepare(['/batch-open']);
    expect(resolveModuleTargetsMock).toHaveBeenCalledTimes(1);
  }),
);

it.effect('keeps prepared targets to the company they were resolved for', () =>
  Effect.gen(function* separatesContexts() {
    resolveModuleTargetsMock.mockReturnValueOnce(
      Effect.succeed({ outcomes: [{ state: 'resolved', target: target('company') }] }),
    );
    yield* prepare(['/company-only']);
    loadHomePageModelMock.mockReturnValue(Effect.succeed(shell('legal-2')));
    resolveModuleTargetMock.mockReturnValueOnce(Effect.succeed(target('other-company')));
    expect(yield* browserModel('/company-only')).toMatchObject({
      target: { entrypointKey: 'party.registry.page.other-company' },
    });
    expect(resolveModuleTargetMock).toHaveBeenCalledTimes(1);
  }),
);

it.effect('leaves every target to its own loader when the batch fails', () =>
  Effect.gen(function* failedBatch() {
    const unavailable = { ...forbidden, _tag: 'ShellCapabilityUnavailableProblem' as const, status: 503 as const };
    resolveModuleTargetsMock.mockReturnValueOnce(Effect.fail(unavailable));
    expect(yield* Effect.flip(prepare(['/failed-batch']))).toBe(unavailable);
    resolveModuleTargetMock.mockReturnValueOnce(Effect.succeed(target('failed-batch')));
    expect(yield* browserModel('/failed-batch')).toMatchObject({ state: 'resolved' });
    expect(resolveModuleTargetMock).toHaveBeenCalledTimes(1);
  }),
);

it.effect('does not ask before the company and its release are known', () =>
  Effect.gen(function* anonymous() {
    loadHomePageModelMock.mockReturnValueOnce(Effect.succeed({ state: 'anonymous' }));
    yield* prepare(['/anonymous']);
    expect(resolveModuleTargetsMock).not.toHaveBeenCalled();
  }),
);
