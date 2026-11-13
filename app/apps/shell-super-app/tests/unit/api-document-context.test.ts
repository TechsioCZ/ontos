import { AccessDecisionGate, makeTestAccessDecision } from '@app/core-runtime/access/enforcement';
import type { GateInput } from '@app/core-runtime/access/enforcement';
import {
  LegalEntityContext,
  ReadPermissionDenied,
  ReadRuntime,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';
import { Deferred, Effect, Exit, Layer, Result, Schema } from 'effect';
import { HttpServerRequest } from 'effect/http';
import { expect, it, rs } from 'effect-rstest';

import { GatewayIssuer } from '../../api/auth/gateway-issuer.ts';
import { AuthenticationService } from '../../api/auth/service.ts';
import type { ShellContextResult } from '../../api/auth/service.ts';
import { documentContextHandler } from '../../api/index.ts';
import {
  makeInstalledModuleCatalogLoader,
  ShellInstalledModuleCatalog,
} from '../../api/modules/installed-module-catalog.ts';
import { ShellGovernedReads } from '../../api/modules/shell-governed-reads.ts';
import type { ShellGovernedReadsService } from '../../api/modules/shell-governed-reads.ts';
import { ResolvedModuleTargetSchema, ShellCompositionSchema, ShellDocumentContextSchema } from '../../shared/api.ts';
import type { ShellDocumentContextRequest } from '../../shared/api.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import { makeShellTestAccessGate } from '../support/access-decision-double.ts';
import { makeAuthenticationServiceDouble } from '../support/impersonation-service-doubles.ts';

const principal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authContextRef: 'session:document-context',
  authenticationNamespaceId: 'staff',
  authMethod: 'session',
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId: '10000000-0000-4000-8000-000000000001',
});
const legalEntity = {
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  legalName: 'Document company',
};
const identity = {
  displayName: 'Document user',
  email: 'document@example.test',
  principalId: principal.principalId,
  tenantId: principal.tenantId,
};
const authenticated: ShellContextResult = {
  availableLegalEntities: [legalEntity],
  identity: { ...identity, ...legalEntity },
  principal,
  setCookieHeaders: [],
  state: 'authenticated',
};
const request = { headers: { cookie: 'session=document-context', 'x-correlation-id': 'document-correlation' } };
const denied = [{ decision: 'denied' as const, key: principal.tenantId }];
const unavailable = [{ decision: 'unavailable' as const, key: principal.tenantId }];

/** The scripted answer of one gate question, written as the decision it stands for. */
type TenantDecisions = Effect.Effect<
  readonly { readonly decision: 'allowed' | 'denied' | 'unavailable'; readonly key: string }[]
>;

const fixture = Effect.gen(function* documentFixture() {
  const snapshot = yield* makeCompositionSnapshot([]);
  const catalog = yield* makeInstalledModuleCatalogLoader(Effect.succeed(snapshot));
  const composition = Schema.decodeUnknownSync(ShellCompositionSchema)({
    compositionRevision: catalog.composition.revision,
    deniedAppIds: [],
    gatewayAudiences: [],
    homeComponents: [],
    navigation: [],
    state: 'available',
    unavailableDeployments: [],
  });
  return { catalog, composition };
});

const documentTest = Effect.fn('test.documentContext')(function* documentTest(
  context: ShellContextResult,
  hint: TenantDecisions,
  composition: ShellGovernedReadsService['composition'],
  peopleStarted: Effect.Effect<unknown> = Effect.void,
  tenantAccess: TenantDecisions = Effect.succeed(denied),
  page: {
    readonly moduleTarget?: ShellGovernedReadsService['moduleTarget'];
    readonly payload?: ShellDocumentContextRequest;
    readonly tenantModuleTarget?: ShellGovernedReadsService['tenantModuleTarget'];
  } = {},
) {
  const { catalog } = yield* fixture;
  const readComposition = rs.fn(composition);
  // The document context never signs gateway assertions: the browser asks the batch issuer for them.
  const issue = rs.fn(() => Effect.die('The document context must not issue gateway assertions'));
  /** One scripted v2 answer for a question, from the first of the given decisions. */
  const answer = (decisions: TenantDecisions, input: GateInput) =>
    decisions.pipe(
      Effect.flatMap(([decision]) =>
        makeShellTestAccessGate({ defaultAnswer: decision?.decision ?? 'unavailable' }).decide(input),
      ),
    );
  // Each Shell question is told apart by the declaration it carries, as the one gate decides it.
  const tenantSelection = rs.fn((input: GateInput) => answer(hint, input));
  const releaseHint = rs.fn((input: GateInput) => answer(tenantAccess, input));
  const peopleCheck = rs.fn((input: GateInput) =>
    peopleStarted.pipe(Effect.andThen(answer(Effect.succeed(denied), input))),
  );
  const decide = (input: GateInput) => {
    const key = input.carrier.accessDeclaration?.key;
    if (key === 'core.identity.people-directory.list') {
      return peopleCheck(input);
    }
    if (key === 'core.shell.tenant-module-target.resolve') {
      return releaseHint(input);
    }
    return tenantSelection(input);
  };
  const readModuleTarget = rs.fn(page.moduleTarget ?? (() => Effect.die('No page target was asked for')));
  const readTenantTarget = rs.fn(page.tenantModuleTarget ?? (() => Effect.die('No tenant page target was asked for')));
  const resolveDocumentContext = rs.fn((headers: Headers) => {
    expect(headers.get('cookie')).toBe('session=document-context');
    return Effect.succeed({ context, tenants: Result.succeed({ setCookieHeaders: [], tenants: [] }) });
  });
  const response = yield* documentContextHandler(request, page.payload ?? {}).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(
          AuthenticationService,
          makeAuthenticationServiceDouble({
            resolveDocumentContext,
          }),
        ),
        Layer.succeed(AccessDecisionGate, { ...makeTestAccessDecision(), decide }),
        Layer.succeed(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(new Request('https://shell.test/shell/document-context')),
        ),
        Layer.mock(LegalEntityContext, {}),
        Layer.mock(ReadRuntime, {}),
        Layer.succeed(ShellInstalledModuleCatalog, { load: Effect.succeed(catalog) }),
        Layer.mock(ShellGovernedReads, {
          composition: readComposition,
          moduleTarget: readModuleTarget,
          tenantModuleTarget: readTenantTarget,
        }),
        Layer.mock(GatewayIssuer, { issueDocument: issue }),
      ),
    ),
    Effect.flatMap(Schema.decodeUnknownEffect(ShellDocumentContextSchema)),
  );
  return {
    issue,
    peopleCheck,
    readComposition,
    readModuleTarget,
    readTenantTarget,
    releaseHint,
    resolveDocumentContext,
    response,
    tenantSelection,
  };
});

it.live('overlaps the switcher hint with composition and people reads, and issues no gateway assertions', () =>
  Effect.gen(function* overlappingDocumentReads() {
    const { composition } = yield* fixture;
    const hintStarted = yield* Deferred.make<boolean>();
    const compositionStarted = yield* Deferred.make<boolean>();
    const peopleStarted = yield* Deferred.make<boolean>();
    const hint = Deferred.succeed(hintStarted, true).pipe(
      Effect.andThen(Deferred.await(compositionStarted)),
      Effect.andThen(Deferred.await(peopleStarted)),
      Effect.as(denied),
    );
    const { issue, readComposition, response } = yield* documentTest(
      authenticated,
      hint,
      (input) => {
        expect(input).toEqual({ correlationId: 'document-correlation', principal });
        return Deferred.await(hintStarted).pipe(
          Effect.andThen(Deferred.succeed(compositionStarted, true)),
          Effect.as(composition),
        );
      },
      Deferred.await(hintStarted).pipe(Effect.andThen(Deferred.succeed(peopleStarted, true))),
    );
    expect(readComposition).toHaveBeenCalledTimes(1);
    expect(response).toMatchObject({
      canManagePeople: false,
      composition: { state: 'available' },
      legalEntities: { selectedLegalEntityId: legalEntity.legalEntityId, tenantContextAvailable: false },
      session: { state: 'authenticated' },
    });
    expect(response).not.toHaveProperty('gatewayAssertions');
    expect(issue).not.toHaveBeenCalled();
  }).pipe(Effect.timeout('2 seconds')),
);

for (const decisions of [denied, unavailable]) {
  it.effect(
    `keeps ${decisions[0]?.decision} switcher permission separate from composition denial and people privileges`,
    () =>
      Effect.gen(function* deniedDocumentPrivileges() {
        const { issue, response } = yield* documentTest(authenticated, Effect.succeed(decisions), () =>
          Effect.fail(new ReadPermissionDenied({ code: 'read_permission_denied', reason: 'denied' })),
        );
        expect(response.composition).toEqual({ state: 'unavailable' });
        expect(response.legalEntities?.tenantContextAvailable).toBe(false);
        expect(response).not.toHaveProperty('canManagePeople');
        expect(response).not.toHaveProperty('gatewayAssertions');
        expect(response).not.toHaveProperty('home');
        expect(issue).not.toHaveBeenCalled();
      }),
  );
}

it.effect(
  'keeps an unavailable switcher hint false without granting people access or discarding admitted composition',
  () =>
    Effect.gen(function* unavailableSwitcherHint() {
      const { composition } = yield* fixture;
      const { response } = yield* documentTest(authenticated, Effect.succeed(unavailable), () =>
        Effect.succeed(composition),
      );
      expect(response.legalEntities?.tenantContextAvailable).toBe(false);
      expect(response.canManagePeople).toBe(false);
      expect(response.composition).toEqual(composition);
    }),
);

it.effect('does not start permission, composition or assertion reads for an anonymous document', () =>
  Effect.gen(function* anonymousDocument() {
    const { issue, peopleCheck, readComposition, releaseHint, response, tenantSelection } = yield* documentTest(
      { setCookieHeaders: [], state: 'anonymous' },
      Effect.die('Anonymous documents must not read permissions'),
      () => Effect.die('Anonymous documents must not load composition'),
    );
    expect(response).toEqual({ session: { state: 'anonymous' } });
    expect(releaseHint).not.toHaveBeenCalled();
    expect(peopleCheck).not.toHaveBeenCalled();
    expect(tenantSelection).not.toHaveBeenCalled();
    expect(readComposition).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
  }),
);

it.live('interrupts pending composition and people reads when the parallel hint defects', () =>
  Effect.gen(function* scopedDocumentReads() {
    const compositionStarted = yield* Deferred.make<boolean>();
    const peopleStarted = yield* Deferred.make<boolean>();
    let compositionInterrupted = false;
    let peopleInterrupted = false;
    const exit = yield* documentTest(
      authenticated,
      Deferred.await(compositionStarted).pipe(
        Effect.andThen(Deferred.await(peopleStarted)),
        Effect.andThen(Effect.die('Unexpected permission defect')),
      ),
      () =>
        Deferred.succeed(compositionStarted, true).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              compositionInterrupted = true;
            }),
          ),
        ),
      Deferred.succeed(peopleStarted, true).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            peopleInterrupted = true;
          }),
        ),
      ),
    ).pipe(Effect.exit);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(compositionInterrupted).toBe(true);
    expect(peopleInterrupted).toBe(true);
  }).pipe(Effect.timeout('2 seconds')),
);

for (const state of ['selection_required', 'access_blocked', 'tenant_authenticated'] as const) {
  it.effect(`never starts company composition, people checks or assertions for ${state}`, () =>
    Effect.gen(function* noCompanyAdmission() {
      const { legalEntityId, ...tenantPrincipal } = principal;
      void legalEntityId;
      const base = {
        identity,
        principal: tenantPrincipal,
        setCookieHeaders: [],
      };
      const context: ShellContextResult =
        state === 'tenant_authenticated'
          ? { ...base, availableLegalEntities: [legalEntity], state }
          : { ...base, availableLegalEntities: [], state };
      const { issue, peopleCheck, readComposition, releaseHint, response, tenantSelection } = yield* documentTest(
        context,
        Effect.succeed(
          state === 'tenant_authenticated' ? [{ decision: 'allowed', key: principal.tenantId }] : unavailable,
        ),
        () => Effect.die('Company composition must not run without company admission'),
      );
      expect(response.composition).toEqual({
        navigation: [],
        state: state === 'tenant_authenticated' ? 'selection_required' : state,
      });
      expect(response.session.state).toBe(state);
      expect(response.legalEntities?.legalEntities).toEqual(state === 'tenant_authenticated' ? [legalEntity] : []);
      expect(response.legalEntities?.tenantContextAvailable).toBe(state === 'tenant_authenticated');
      expect(response.legalEntities).not.toHaveProperty('selectedLegalEntityId');
      expect(response).not.toHaveProperty('canManagePeople');
      expect(response).not.toHaveProperty('gatewayAssertions');
      expect(readComposition).not.toHaveBeenCalled();
      expect(issue).not.toHaveBeenCalled();
      expect(tenantSelection).toHaveBeenCalledTimes(1);
      expect(tenantSelection.mock.calls[0]?.[0]).toMatchObject({
        carrier: { accessDeclaration: { admitsAdminSurface: true, key: 'shell-super-app.access-admin.people' } },
        legalEntityScope: 'forbidden',
        scope: { principalId: principal.principalId, tenantId: principal.tenantId },
      });
      expect(peopleCheck).not.toHaveBeenCalled();
      expect(releaseHint).toHaveBeenCalledTimes(state === 'tenant_authenticated' ? 1 : 0);
      expect(response).not.toHaveProperty('compositionRevision');
      if (state === 'tenant_authenticated') {
        expect(releaseHint.mock.calls[0]?.[0]).toMatchObject({
          carrier: { accessDeclaration: { key: 'core.shell.tenant-module-target.resolve' } },
          legalEntityScope: 'optional',
          scope: { principalId: principal.principalId, tenantId: principal.tenantId },
        });
      }
    }),
  );
}

it.effect(
  'exposes only the captured revision to a verified tenant with canonical access, independently of switcher permission',
  () =>
    Effect.gen(function* tenantSearchRevision() {
      const { legalEntityId, ...tenantPrincipal } = principal;
      void legalEntityId;
      const context: ShellContextResult = {
        availableLegalEntities: [legalEntity],
        identity,
        principal: tenantPrincipal,
        setCookieHeaders: [],
        state: 'tenant_authenticated',
      };
      const { catalog } = yield* fixture;
      const { issue, readComposition, releaseHint, response } = yield* documentTest(
        context,
        Effect.succeed(denied),
        () => Effect.die('Tenant search must not request a company composition'),
        Effect.void,
        Effect.succeed([{ decision: 'allowed', key: principal.tenantId }]),
      );
      expect(response.compositionRevision).toBe(catalog.composition.revision);
      expect(response.composition).toEqual({ navigation: [], state: 'selection_required' });
      expect(response.session.state).toBe('tenant_authenticated');
      expect(response.legalEntities?.tenantContextAvailable).toBe(false);
      expect(response.legalEntities).not.toHaveProperty('selectedLegalEntityId');
      expect(response).not.toHaveProperty('gatewayAssertions');
      expect(response).not.toHaveProperty('canManagePeople');
      expect(response).not.toHaveProperty('home');
      expect(issue).not.toHaveBeenCalled();
      expect(readComposition).not.toHaveBeenCalled();
      // The hint goes exactly to the people tenant-context page dispatch admits (O28).
      expect(releaseHint.mock.calls[0]?.[0]).toMatchObject({
        carrier: { accessDeclaration: { key: 'core.shell.tenant-module-target.resolve' } },
        legalEntityScope: 'optional',
        scope: { principalId: principal.principalId, tenantId: principal.tenantId },
      });
    }),
);

for (const decisions of [denied, unavailable]) {
  it.effect(`never exposes a release revision when tenant page dispatch is ${decisions[0]?.decision}`, () =>
    Effect.gen(function* noTenantSearchRevision() {
      const { legalEntityId, ...tenantPrincipal } = principal;
      void legalEntityId;
      const context: ShellContextResult = {
        availableLegalEntities: [legalEntity],
        identity,
        principal: tenantPrincipal,
        setCookieHeaders: [],
        state: 'tenant_authenticated',
      };
      const { issue, readComposition, response } = yield* documentTest(
        context,
        Effect.succeed([{ decision: 'allowed', key: principal.tenantId }]),
        () => Effect.die('No company composition'),
        Effect.void,
        Effect.succeed(decisions),
      );
      expect(response).not.toHaveProperty('compositionRevision');
      expect(response).not.toHaveProperty('gatewayAssertions');
      expect(response.legalEntities?.tenantContextAvailable).toBe(true);
      expect(issue).not.toHaveBeenCalled();
      expect(readComposition).not.toHaveBeenCalled();
    }),
  );
}

it.effect('rereads switcher permission on the next document instead of retaining an allowed hint', () =>
  Effect.gen(function* freshSwitcherPermission() {
    const { composition } = yield* fixture;
    const allowed = yield* documentTest(
      authenticated,
      Effect.succeed([{ decision: 'allowed', key: principal.tenantId }]),
      () => Effect.succeed(composition),
    );
    const revoked = yield* documentTest(authenticated, Effect.succeed(denied), () => Effect.succeed(composition));
    expect(allowed.response.legalEntities?.tenantContextAvailable).toBe(true);
    expect(revoked.response.legalEntities?.tenantContextAvailable).toBe(false);
    expect(allowed.response.canManagePeople).toBe(false);
    expect(revoked.response.canManagePeople).toBe(false);
    for (const result of [allowed, revoked]) {
      expect(result.tenantSelection).toHaveBeenCalledTimes(1);
      expect(result.tenantSelection.mock.calls[0]?.[0]).toMatchObject({
        carrier: { accessDeclaration: { admitsAdminSurface: true, key: 'shell-super-app.access-admin.people' } },
        scope: { principalId: principal.principalId, tenantId: principal.tenantId },
      });
    }
  }),
);

const pageTarget = (compositionRevision: string) =>
  Schema.decodeUnknownSync(ResolvedModuleTargetSchema)({
    appId: 'party-registry',
    componentKey: 'party.registry.page-contacts',
    compositionRevision,
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

it.effect('resolves a module page target in the same document read, for the same principal and release', () =>
  Effect.gen(function* foldedTarget() {
    const { catalog, composition } = yield* fixture;
    const { readComposition, readModuleTarget, resolveDocumentContext, response } = yield* documentTest(
      authenticated,
      Effect.succeed(denied),
      () => Effect.succeed(composition),
      Effect.void,
      Effect.succeed(denied),
      {
        moduleTarget: (input) => Effect.succeed(pageTarget(input.compositionRevision ?? '')),
        payload: { target: { canonicalPath: '/contacts' } },
      },
    );
    // One session resolution answers the Shell context and the page target together.
    expect(resolveDocumentContext).toHaveBeenCalledTimes(1);
    expect(readModuleTarget).toHaveBeenCalledTimes(1);
    expect(readModuleTarget.mock.calls[0]?.[0]).toEqual({
      canonicalPath: '/contacts',
      compositionRevision: catalog.composition.revision,
      correlationId: 'document-correlation',
      principal,
    });
    expect(readComposition.mock.calls[0]?.[0]).toEqual({ correlationId: 'document-correlation', principal });
    expect(response.target).toEqual({ state: 'resolved', target: pageTarget(catalog.composition.revision) });
    expect(response.composition).toMatchObject({ state: 'available' });
  }),
);

it.effect('answers a refused page target as its own outcome, never as the document failing', () =>
  Effect.gen(function* refusedTarget() {
    const { composition } = yield* fixture;
    const { response } = yield* documentTest(
      authenticated,
      Effect.succeed(denied),
      () => Effect.succeed(composition),
      Effect.void,
      Effect.succeed(denied),
      {
        moduleTarget: () => Effect.fail(new ReadPermissionDenied({ code: 'read_permission_denied', reason: 'denied' })),
        payload: { target: { canonicalPath: '/contacts' } },
      },
    );
    expect(response.composition).toMatchObject({ state: 'available' });
    expect(response.target).toMatchObject({ problem: { _tag: 'ShellTargetForbiddenProblem' }, state: 'failed' });
  }),
);

it.effect('answers no page target when the document has no composition to admit it', () =>
  Effect.gen(function* noCompositionNoTarget() {
    const { response } = yield* documentTest(
      authenticated,
      Effect.succeed(denied),
      () => Effect.fail(new ReadPermissionDenied({ code: 'read_permission_denied', reason: 'denied' })),
      Effect.void,
      Effect.succeed(denied),
      {
        moduleTarget: (input) => Effect.succeed(pageTarget(input.compositionRevision ?? '')),
        payload: { target: { canonicalPath: '/contacts' } },
      },
    );
    expect(response.composition).toEqual({ state: 'unavailable' });
    expect(response).not.toHaveProperty('target');
  }),
);

for (const decision of ['allowed', 'denied'] as const) {
  it.effect(`reads a tenant session's page target only beside an admitted release hint: ${decision}`, () =>
    Effect.gen(function* tenantTarget() {
      const { legalEntityId, ...tenantPrincipal } = principal;
      void legalEntityId;
      const { catalog } = yield* fixture;
      const { readModuleTarget, readTenantTarget, response } = yield* documentTest(
        {
          availableLegalEntities: [legalEntity],
          identity,
          principal: tenantPrincipal,
          setCookieHeaders: [],
          state: 'tenant_authenticated',
        },
        Effect.succeed(denied),
        () => Effect.die('Tenant documents read no company composition'),
        Effect.void,
        Effect.succeed([{ decision, key: principal.tenantId }]),
        {
          payload: { target: { canonicalPath: '/contacts' } },
          tenantModuleTarget: (input) =>
            Effect.succeed({ state: 'resolved' as const, target: pageTarget(input.compositionRevision ?? '') }),
        },
      );
      expect(readModuleTarget).not.toHaveBeenCalled();
      if (decision === 'allowed') {
        expect(readTenantTarget.mock.calls[0]?.[0]).toMatchObject({
          canonicalPath: '/contacts',
          compositionRevision: catalog.composition.revision,
          principal: tenantPrincipal,
        });
        expect(response.target).toEqual({ state: 'resolved', target: pageTarget(catalog.composition.revision) });
      } else {
        expect(readTenantTarget).not.toHaveBeenCalled();
        expect(response).not.toHaveProperty('target');
        expect(response).not.toHaveProperty('compositionRevision');
      }
    }),
  );
}
