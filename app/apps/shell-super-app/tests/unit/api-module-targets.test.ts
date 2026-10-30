import {
  ContextAccess,
  LegalEntityContext,
  ReadPermissionDenied,
  TrustedPrincipalContextSchema,
  withRequestPermissionDecisions,
} from '@app/core-runtime';
import { Effect, Exit, Layer, Schema } from 'effect';
import { HttpServerRequest } from 'effect/http';
import { expect, it, rs } from 'effect-rstest';

import { AuthenticationService } from '../../api/auth/service.ts';
import type { ShellContextResult } from '../../api/auth/service.ts';
import { moduleTargetsHandler } from '../../api/index.ts';
import {
  makeInstalledModuleCatalogLoader,
  ShellInstalledModuleCatalog,
} from '../../api/modules/installed-module-catalog.ts';
import { ShellGovernedReads } from '../../api/modules/shell-governed-reads.ts';
import type { ShellGovernedReadsService } from '../../api/modules/shell-governed-reads.ts';
import { ModuleIdSchema, ResolvedModuleTargetSchema, ResolvedModuleTargetsSchema } from '../../shared/api.ts';
import type { ResolveModuleTargetsPayload } from '../../shared/api.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import { makeContextAccessDouble } from '../support/context-access-double.ts';
import { makeAuthenticationServiceDouble } from '../support/impersonation-service-doubles.ts';

const principal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authContextRef: 'session:module-targets',
  authenticationNamespaceId: 'staff',
  authMethod: 'session',
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId: '10000000-0000-4000-8000-000000000001',
});
const legalEntity = { legalEntityId: principal.legalEntityId ?? '', legalName: 'Target company' };
const authenticated: ShellContextResult = {
  availableLegalEntities: [legalEntity],
  identity: {
    displayName: 'Target user',
    email: 'target@example.test',
    principalId: principal.principalId,
    tenantId: principal.tenantId,
    ...legalEntity,
  },
  principal,
  setCookieHeaders: [],
  state: 'authenticated',
};
const request = { headers: { cookie: 'session=module-targets', 'x-correlation-id': 'targets-correlation' } };

const run = Effect.fn('test.moduleTargets')(function* run(
  payload: (revision: string) => ResolveModuleTargetsPayload,
  moduleTarget: ShellGovernedReadsService['moduleTarget'],
) {
  const snapshot = yield* makeCompositionSnapshot([]);
  const catalog = yield* makeInstalledModuleCatalogLoader(Effect.succeed(snapshot));
  const { revision } = catalog.composition;
  const resolveShellContext = rs.fn(() => Effect.succeed(authenticated));
  const readTarget = rs.fn(moduleTarget);
  const exit = yield* withRequestPermissionDecisions(moduleTargetsHandler(request, payload(revision))).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(AuthenticationService, makeAuthenticationServiceDouble({ resolveShellContext })),
        Layer.succeed(ContextAccess, makeContextAccessDouble('allowed')),
        Layer.succeed(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(new Request('https://shell.test/shell/module-targets')),
        ),
        Layer.mock(LegalEntityContext, {}),
        Layer.succeed(ShellInstalledModuleCatalog, { load: Effect.succeed(catalog) }),
        Layer.mock(ShellGovernedReads, { moduleTarget: readTarget }),
      ),
    ),
    Effect.exit,
  );
  return { exit, readTarget, resolveShellContext, revision };
});

const targetOf = (canonicalPath: string, compositionRevision: string) =>
  Schema.decodeUnknownSync(ResolvedModuleTargetSchema)({
    appId: 'party-registry',
    componentKey: 'party.registry.page-contacts',
    compositionRevision,
    entrypointKey: `party.registry.page${canonicalPath.replaceAll('/', '.')}`,
    federation: {
      expose: './PageContacts',
      manifest: { sha256: 'a'.repeat(64), url: 'https://assets.example.test/party/mf-manifest.json' },
      remoteName: 'partyRegistry',
    },
    moduleId: 'party.registry',
    routeParameters: {},
    writable: true,
  });

it.effect('resolves every target as its own governed read under one session and one captured release', () =>
  Effect.gen(function* oneSessionManyReads() {
    const { exit, readTarget, resolveShellContext, revision } = yield* run(
      (compositionRevision) => ({
        compositionRevision,
        targets: [
          { canonicalPath: '/open' },
          { canonicalPath: '/closed' },
          { moduleId: ModuleIdSchema.make('party.registry') },
        ],
      }),
      (input) =>
        input.canonicalPath === '/closed'
          ? Effect.fail(new ReadPermissionDenied({ code: 'read_permission_denied', reason: 'denied' }))
          : Effect.succeed(targetOf(input.canonicalPath ?? '/landing', input.compositionRevision ?? '')),
    );
    expect(resolveShellContext).toHaveBeenCalledTimes(1);
    expect(readTarget).toHaveBeenCalledTimes(3);
    for (const [input] of readTarget.mock.calls) {
      expect(input).toMatchObject({
        compositionRevision: revision,
        correlationId: 'targets-correlation',
        principal,
      });
    }
    expect(readTarget.mock.calls.map(([input]) => input.canonicalPath ?? input.moduleId)).toEqual([
      '/open',
      '/closed',
      'party.registry',
    ]);
    expect(Exit.isSuccess(exit)).toBe(true);
    const response = Schema.decodeUnknownSync(ResolvedModuleTargetsSchema)(
      Exit.match(exit, { onFailure: () => null, onSuccess: (value) => value }),
    );
    expect(response.outcomes.map((outcome) => outcome.state)).toEqual(['resolved', 'failed', 'resolved']);
    expect(response.outcomes[1]).toMatchObject({ problem: { _tag: 'ShellTargetForbiddenProblem' } });
  }),
);

it.effect('fails the whole request for a stale release without reading any target', () =>
  Effect.gen(function* staleRelease() {
    const { exit, readTarget } = yield* run(
      () => ({ compositionRevision: 'f'.repeat(64), targets: [{ canonicalPath: '/open' }] }),
      () => Effect.die('unexpected target read'),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain('ShellReloadRequiredProblem');
    expect(readTarget).not.toHaveBeenCalled();
  }),
);
