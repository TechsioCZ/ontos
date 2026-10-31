import {
  ReadHandlerNotFound,
  ReadHandlerUnavailable,
  ReadPermissionDenied,
  ReadPermissionUnavailable,
  ReadRuntime,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';
import { Effect, Layer, Schema } from 'effect';
import { assert, beforeEach, expect, it, rstest } from 'effect-rstest';

import { DocumentHomeCorrelationId, resolveDocumentHome } from '../../api/modules/shell-document-home.ts';
import { ShellGovernedReads } from '../../api/modules/shell-governed-reads.ts';
import type { ShellGovernedReadsService } from '../../api/modules/shell-governed-reads.ts';
import { ResolvedModuleTargetSchema, ShellCompositionSchema } from '../../shared/api.ts';

const decodedPrincipal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authContextRef: 'session:document-home',
  authenticationNamespaceId: 'staff',
  authMethod: 'session',
  legalEntityId: '20000000-0000-4000-8000-000000000001',
  principalId: '30000000-0000-4000-8000-000000000001',
  tenantId: '10000000-0000-4000-8000-000000000001',
});
assert.ok(decodedPrincipal.legalEntityId !== undefined);
const principal = { ...decodedPrincipal, legalEntityId: decodedPrincipal.legalEntityId };
const compositionRevision = '1'.repeat(64);
const composition = Schema.decodeUnknownSync(ShellCompositionSchema)({
  compositionRevision,
  deniedAppIds: [],
  gatewayAudiences: [],
  homeComponents: ['fixture.first', 'fixture.second'].map((moduleId, order) => ({
    entrypointKey: `${moduleId}.component.home`,
    moduleId,
    order,
    requiresModules: [moduleId],
  })),
  navigation: ['fixture.first', 'fixture.second'].map((moduleId, order) => ({
    appId: 'fixture-app',
    enabled: true,
    entrypointKey: `${moduleId}.page.records`,
    groupKey: 'shell.navigation.modules',
    href: `/modules/${moduleId}`,
    icon: 'icon-[mdi--view-grid-outline]',
    label: { cs: 'Modul', en: 'Module' },
    moduleId,
    order,
    state: 'active',
    unavailable: false,
    writable: true,
  })),
  state: 'available',
  unavailableDeployments: [],
});
assert.ok(composition.state === 'available');
const target = Schema.decodeUnknownSync(ResolvedModuleTargetSchema)({
  appId: 'fixture-app',
  componentKey: 'fixture.first.home',
  compositionRevision,
  entrypointKey: 'fixture.first.component.home',
  federation: {
    expose: './Home',
    manifest: { sha256: '2'.repeat(64), url: 'https://fixture.example.test/mf-manifest.json' },
    remoteName: 'fixtureRemote',
  },
  moduleId: 'fixture.first',
  routeParameters: {},
  writable: false,
});
const moduleTarget = rstest.fn<ShellGovernedReadsService['moduleTarget']>();
interface CoreReadRequest {
  readonly principal: unknown;
  readonly transport: unknown;
}
const runRead = rstest.fn((_request: CoreReadRequest) =>
  Effect.fail(new ReadHandlerUnavailable({ code: 'read_handler_unavailable', reason: 'welcome unavailable' })),
);
const loadHome = (overrides: Partial<typeof composition> = {}) =>
  resolveDocumentHome({ canManagePeople: false, composition: { ...composition, ...overrides }, principal }).pipe(
    Effect.provide(Layer.mock(ShellGovernedReads, { moduleTarget })),
    Effect.provide(Layer.mock(ReadRuntime, { runRead })),
    Effect.provideService(DocumentHomeCorrelationId, 'home-correlation'),
  );

beforeEach(() => {
  moduleTarget.mockReturnValue(Effect.succeed(target));
});

it.effect('resolves the first admitted candidate with the document revision, principal and audit correlation', () =>
  Effect.gen(function* firstCandidate() {
    expect(yield* loadHome()).toEqual({ contribution: { state: 'ready', target } });
    expect(moduleTarget).toHaveBeenCalledExactlyOnceWith({
      compositionRevision,
      correlationId: 'home-correlation',
      entrypointKey: 'fixture.first.component.home',
      moduleId: 'fixture.first',
      principal,
    });
    expect(runRead).not.toHaveBeenCalled();
  }),
);

it.effect('advances only after a definite denial or missing candidate', () =>
  Effect.gen(function* deniedCandidates() {
    moduleTarget.mockReturnValueOnce(
      Effect.fail(new ReadPermissionDenied({ code: 'read_permission_denied', reason: 'denied' })),
    );
    expect(yield* loadHome()).toEqual({ contribution: { state: 'ready', target } });
    expect(moduleTarget.mock.calls[1]?.[0].moduleId).toBe('fixture.second');
    moduleTarget.mockClear();
    moduleTarget.mockReturnValueOnce(
      Effect.fail(new ReadHandlerNotFound({ code: 'read_handler_not_found', reason: 'missing' })),
    );
    expect(yield* loadHome()).toEqual({ contribution: { state: 'ready', target } });
    expect(moduleTarget).toHaveBeenCalledTimes(2);
  }),
);

it.effect('keeps unavailable admission unavailable instead of advancing or showing a welcome', () =>
  Effect.gen(function* unavailableCandidate() {
    moduleTarget.mockReturnValueOnce(
      Effect.fail(
        new ReadPermissionUnavailable({
          code: 'read_permission_unavailable',
          reason: 'permission service unavailable',
        }),
      ),
    );
    expect(yield* loadHome()).toEqual({ contribution: { state: 'unavailable' } });
    expect(moduleTarget).toHaveBeenCalledTimes(1);
    expect(runRead).not.toHaveBeenCalled();
  }),
);

it.effect('does not resolve components requiring an unlisted module', () =>
  Effect.gen(function* missingRequiredModule() {
    expect(
      yield* loadHome({
        homeComponents: composition.homeComponents.map((candidate) => ({ ...candidate, requiresModules: [] })),
        navigation: [],
      }),
    ).toEqual({ contribution: { state: 'ready', target } });
    moduleTarget.mockClear();
    expect(yield* loadHome({ navigation: [] })).toEqual({
      contribution: { state: 'forbidden' },
    });
    expect(moduleTarget).not.toHaveBeenCalled();
    expect(runRead).toHaveBeenCalledTimes(1);
    expect(runRead.mock.calls[0]?.[0]).toMatchObject({ principal, transport: { correlationId: 'home-correlation' } });
  }),
);

it.effect('keeps the welcome optional when its own governed Core read is unavailable', () =>
  Effect.gen(function* unavailableWelcome() {
    runRead.mockReturnValueOnce(
      Effect.fail(new ReadHandlerUnavailable({ code: 'read_handler_unavailable', reason: 'welcome unavailable' })),
    );
    expect(yield* loadHome({ homeComponents: [] })).toEqual({ contribution: { state: 'forbidden' } });
    expect(moduleTarget).not.toHaveBeenCalled();
  }),
);
