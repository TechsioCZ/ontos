import {
  ContextAccess,
  LegalEntityContext,
  ReadPermissionDenied,
  ReadRuntime,
  TrustedPrincipalContextSchema,
  withRequestPermissionDecisions,
} from '@app/core-runtime';
import { Deferred, Effect, Exit, Layer, Result, Schema } from 'effect';
import { HttpServerRequest } from 'effect/unstable/http';
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
import { ShellCompositionSchema, ShellDocumentContextSchema } from '../../shared/api.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import { makeContextAccessDouble } from '../support/context-access-double.ts';
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

type TenantDecisions = ReturnType<ReturnType<typeof makeContextAccessDouble>['tenants']>;

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
  issueDocument: Effect.Effect<readonly []> = Effect.succeed([] as const),
  peopleStarted: Effect.Effect<unknown> = Effect.void,
) {
  const { catalog } = yield* fixture;
  const readComposition = rs.fn(composition);
  const issue = rs.fn(() => issueDocument);
  const tenantPermissions = rs.fn(({ permission }: { readonly permission: string }) =>
    permission === 'select_context' ? hint : peopleStarted.pipe(Effect.as(denied)),
  );
  const response = yield* withRequestPermissionDecisions(documentContextHandler(request, {})).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(
          AuthenticationService,
          makeAuthenticationServiceDouble({
            resolveDocumentContext: (headers) => {
              expect(headers.get('cookie')).toBe('session=document-context');
              return Effect.succeed({ context, tenants: Result.succeed({ setCookieHeaders: [], tenants: [] }) });
            },
          }),
        ),
        Layer.succeed(ContextAccess, {
          ...makeContextAccessDouble('allowed'),
          legalEntities: ({ legalEntityIds }) =>
            Effect.succeed(legalEntityIds.map((key) => ({ decision: 'denied' as const, key }))),
          tenants: tenantPermissions,
        }),
        Layer.succeed(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(new Request('https://shell.test/shell/document-context')),
        ),
        Layer.mock(LegalEntityContext, {}),
        Layer.mock(ReadRuntime, {}),
        Layer.succeed(ShellInstalledModuleCatalog, { load: Effect.succeed(catalog) }),
        Layer.mock(ShellGovernedReads, { composition: readComposition }),
        Layer.mock(GatewayIssuer, { issueDocument: issue }),
      ),
    ),
    Effect.flatMap(Schema.decodeUnknownEffect(ShellDocumentContextSchema)),
  );
  return { issue, readComposition, response, tenantPermissions };
});

it.live('overlaps the switcher hint with composition and people reads, joining only after document assertions', () =>
  Effect.gen(function* overlappingDocumentReads() {
    const { composition } = yield* fixture;
    const hintStarted = yield* Deferred.make<boolean>();
    const compositionStarted = yield* Deferred.make<boolean>();
    const peopleStarted = yield* Deferred.make<boolean>();
    const assertionsFinished = yield* Deferred.make<boolean>();
    const hint = Deferred.succeed(hintStarted, true).pipe(
      Effect.andThen(Deferred.await(compositionStarted)),
      Effect.andThen(Deferred.await(peopleStarted)),
      Effect.andThen(Deferred.await(assertionsFinished)),
      Effect.as(denied),
    );
    const { readComposition, response } = yield* documentTest(
      authenticated,
      hint,
      (input) => {
        expect(input).toEqual({ correlationId: 'document-correlation', principal });
        return Deferred.await(hintStarted).pipe(
          Effect.andThen(Deferred.succeed(compositionStarted, true)),
          Effect.as(composition),
        );
      },
      Deferred.succeed(assertionsFinished, true).pipe(Effect.as([] as const)),
      Deferred.await(hintStarted).pipe(Effect.andThen(Deferred.succeed(peopleStarted, true))),
    );
    expect(readComposition).toHaveBeenCalledTimes(1);
    expect(response).toMatchObject({
      canManagePeople: false,
      composition: { state: 'available' },
      gatewayAssertions: [],
      legalEntities: { selectedLegalEntityId: legalEntity.legalEntityId, tenantContextAvailable: false },
      session: { state: 'authenticated' },
    });
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
    const { issue, readComposition, response, tenantPermissions } = yield* documentTest(
      { setCookieHeaders: [], state: 'anonymous' },
      Effect.die('Anonymous documents must not read permissions'),
      () => Effect.die('Anonymous documents must not load composition'),
    );
    expect(response).toEqual({ session: { state: 'anonymous' } });
    expect(tenantPermissions).not.toHaveBeenCalled();
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
      Effect.succeed([] as const),
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

for (const state of ['selection_required', 'access_blocked'] as const) {
  it.effect(`never starts company composition, people checks or assertions for ${state}`, () =>
    Effect.gen(function* noCompanyAdmission() {
      const context: ShellContextResult = {
        availableLegalEntities: [],
        identity,
        principal,
        setCookieHeaders: [],
        state,
      };
      const { issue, readComposition, response, tenantPermissions } = yield* documentTest(
        context,
        Effect.succeed(unavailable),
        () => Effect.die('Company composition must not run without company admission'),
      );
      expect(response.composition).toEqual({ navigation: [], state });
      expect(response.legalEntities?.tenantContextAvailable).toBe(false);
      expect(response.legalEntities).not.toHaveProperty('selectedLegalEntityId');
      expect(response).not.toHaveProperty('canManagePeople');
      expect(response).not.toHaveProperty('gatewayAssertions');
      expect(readComposition).not.toHaveBeenCalled();
      expect(issue).not.toHaveBeenCalled();
      expect(tenantPermissions).toHaveBeenCalledExactlyOnceWith({
        permission: 'select_context',
        principalId: principal.principalId,
        tenantIds: [principal.tenantId],
      });
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
    expect(allowed.tenantPermissions).toHaveBeenCalledWith({
      permission: 'select_context',
      principalId: principal.principalId,
      tenantIds: [principal.tenantId],
    });
    expect(revoked.tenantPermissions).toHaveBeenCalledWith({
      permission: 'select_context',
      principalId: principal.principalId,
      tenantIds: [principal.tenantId],
    });
  }),
);
