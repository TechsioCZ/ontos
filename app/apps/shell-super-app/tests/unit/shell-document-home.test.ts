import {
  ReadHandlerNotFound,
  ReadPermissionDenied,
  ReadPermissionUnavailable,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';
import { Effect, Layer, Schema } from 'effect';
import { assert, beforeEach, expect, it, rstest } from 'effect-rstest';

import { DocumentHomeCorrelationId, resolveDocumentHome } from '../../api/modules/shell-document-home.ts';
import { ShellGovernedReads } from '../../api/modules/shell-governed-reads.ts';
import type { ShellGovernedReadsService } from '../../api/modules/shell-governed-reads.ts';
import { ResolvedModuleTargetSchema, ShellCompositionSchema } from '../../shared/browser-api.ts';
import { tenantModuleTargetTestCarrier } from '../support/tenant-module-target-carrier.ts';

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
  integrationComponents: [],
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
const loadHome = (overrides: Partial<typeof composition> = {}) =>
  resolveDocumentHome({ canManagePeople: false, composition: { ...composition, ...overrides }, principal }).pipe(
    Effect.provide(
      Layer.mock(ShellGovernedReads, { moduleTarget, tenantModuleTargetCarrier: tenantModuleTargetTestCarrier }),
    ),
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
    expect(yield* loadHome({ welcome: 'Bread and pastry for the whole town.' })).toEqual({
      contribution: { state: 'unavailable' },
    });
    expect(moduleTarget).toHaveBeenCalledTimes(1);
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
  }),
);

it.effect('shows the welcome text the composition carries for the company on the welcome page', () =>
  Effect.gen(function* companyWelcome() {
    expect(yield* loadHome({ homeComponents: [], welcome: 'Bread and pastry for the whole town.' })).toEqual({
      contribution: { state: 'forbidden' },
      welcome: 'Bread and pastry for the whole town.',
    });
    expect(yield* loadHome({ welcome: 'Bread and pastry for the whole town.' })).toEqual({
      contribution: { state: 'ready', target },
    });
  }),
);
