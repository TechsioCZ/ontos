import { LegalEntityContext, LegalEntityContextUnavailableError, classifyActiveLegalEntities } from '@app/core-runtime';
import type { LegalEntityContextService, SafeLegalEntity } from '@app/core-runtime';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { NodeCrypto } from '@effect/platform-node';
import { Effect, Layer, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  canSelectTenantContext,
  resolveAuthorizedLegalEntities,
  validateAuthorizedLegalEntity,
} from '../../api/auth/legal-entity-selection.ts';
import { makeShellTestAccessGate, shellTestScope } from '../support/access-decision-double.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const principalId = '20000000-0000-4000-8000-000000000001';
const scope = shellTestScope({ principalId, tenantId });
const alpha = {
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  legalName: 'Alpha',
};
const beta = {
  legalEntityId: '30000000-0000-4000-8000-000000000002',
  legalName: 'Beta',
};
const gamma = {
  legalEntityId: '30000000-0000-4000-8000-000000000003',
  legalName: 'Gamma',
};

it.layer(NodeCrypto.layer)('native tenant context selection', (suite) => {
  suite.effect('asks the published administration surface with the original identity in tenant context', () =>
    Effect.gen(function* nativeTenantContext() {
      const principal = shellTestScope({ legalEntityId: alpha.legalEntityId, principalId, tenantId });
      const gate = makeShellTestAccessGate({ defaultAnswer: 'allowed' });
      expect(yield* canSelectTenantContext(principal).pipe(Effect.provideService(AccessDecisionGate, gate))).toBe(true);
      expect(gate.singleDecisions).toHaveLength(1);
      const [question] = gate.singleDecisions;
      expect(question).toMatchObject({
        carrier: {
          accessDeclaration: { admitsAdminSurface: true, key: 'shell-super-app.access-admin.people', kind: 'admin' },
        },
        legalEntityScope: 'forbidden',
        scope: {
          authBindingId: principal.authBindingId,
          authContextRef: principal.authContextRef,
          authMethod: principal.authMethod,
          principalId,
          tenantId,
        },
      });
      expect(question?.scope).not.toHaveProperty('legalEntityId');
    }),
  );

  suite.effect('refuses denied or approval-only administration and preserves an unavailable decision', () =>
    Effect.gen(function* tenantContextRefusals() {
      for (const defaultAnswer of ['denied', 'needs_approval'] as const) {
        const gate = makeShellTestAccessGate({ defaultAnswer });
        expect(yield* canSelectTenantContext(scope).pipe(Effect.provideService(AccessDecisionGate, gate))).toBe(false);
      }
      const failure = yield* Effect.flip(
        canSelectTenantContext(scope).pipe(
          Effect.provideService(AccessDecisionGate, makeShellTestAccessGate({ defaultAnswer: 'unavailable' })),
        ),
      );
      expect(Predicate.isTagged(failure, 'LegalEntitySelectionUnavailableError')).toBe(true);
    }),
  );
});

const context = (entities: readonly SafeLegalEntity[] = [alpha, beta]): LegalEntityContextService => ({
  listActiveForTenant: () => Effect.succeed(entities),
  validateSelection: (_tenantId, legalEntityId) => {
    const selected = entities.find((entity) => entity.legalEntityId === legalEntityId);
    return selected === undefined ? Effect.die('missing fixture entity') : Effect.succeed(selected);
  },
});

const provideSelectionServices = <Success, Failure>(
  effect: Effect.Effect<Success, Failure, AccessDecisionGate | LegalEntityContext>,
  legalEntityContext: LegalEntityContextService,
  gate: ReturnType<typeof makeShellTestAccessGate>,
): Effect.Effect<Success, Failure> =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(Layer.succeed(LegalEntityContext, legalEntityContext), Layer.succeed(AccessDecisionGate, gate)),
    ),
  );

it.effect('auto-selects the only selectable company and preserves an exact saved choice', () =>
  Effect.gen(function* autoSelectsTheOnlyCompany() {
    const only = yield* provideSelectionServices(
      resolveAuthorizedLegalEntities({ scope }),
      context(),
      makeShellTestAccessGate({ selectableLegalEntityIds: [alpha.legalEntityId] }),
    );
    expect(only).toEqual({
      available: [alpha],
      selected: alpha,
      state: 'selected',
    });
    const saved = yield* provideSelectionServices(
      resolveAuthorizedLegalEntities({ savedLegalEntityId: beta.legalEntityId, scope }),
      context(),
      makeShellTestAccessGate({ selectableLegalEntityIds: [alpha.legalEntityId, beta.legalEntityId] }),
    );
    expect(saved).toEqual({
      available: [alpha, beta],
      selected: beta,
      state: 'selected',
    });
  }),
);

it.effect('requires a choice for several selectable companies and blocks zero grants', () =>
  Effect.gen(function* requiresAChoiceForSeveralCompanies() {
    expect(
      yield* provideSelectionServices(
        resolveAuthorizedLegalEntities({ scope }),
        context(),
        makeShellTestAccessGate({ selectableLegalEntityIds: [alpha.legalEntityId, beta.legalEntityId] }),
      ),
    ).toEqual({ available: [alpha, beta], state: 'selection_required' });
    expect(
      yield* provideSelectionServices(
        resolveAuthorizedLegalEntities({ scope }),
        context(),
        makeShellTestAccessGate({}),
      ),
    ).toEqual({ available: [], state: 'access_blocked' });
  }),
);

it.effect('never offers a company the select check did not prove, whatever the tenant has', () =>
  Effect.gen(function* neverOffersAnUnprovedCompany() {
    const gate = makeShellTestAccessGate({ selectableLegalEntityIds: [beta.legalEntityId] });
    expect(
      yield* provideSelectionServices(
        resolveAuthorizedLegalEntities({ savedLegalEntityId: alpha.legalEntityId, scope }),
        context(),
        gate,
      ),
    ).toEqual({ available: [beta], selected: beta, state: 'selected' });
    // One question, in this request's own trusted scope, and no per-company loop around it.
    expect(gate.selectableAsks.map(({ scope: asked }) => asked)).toEqual([scope]);
    expect(gate.selectableAsks.every(({ now }) => Schema.is(Schema.Date)(now))).toBe(true);
    expect(gate.singleDecisions).toEqual([]);
  }),
);

it.effect('fails closed when the selectable authority cannot be read', () =>
  Effect.gen(function* failsClosedForUncertainty() {
    const unavailable = yield* Effect.flip(
      provideSelectionServices(
        resolveAuthorizedLegalEntities({ scope }),
        context(),
        makeShellTestAccessGate({ selectionUnavailable: true }),
      ),
    );
    expect(Predicate.isTagged(unavailable, 'LegalEntitySelectionUnavailableError')).toBe(true);
  }),
);

it.effect('validates a switch independently and refuses a company the gate does not offer', () =>
  Effect.gen(function* validatesASwitchIndependently() {
    expect(
      yield* provideSelectionServices(
        validateAuthorizedLegalEntity({ legalEntityId: beta.legalEntityId, scope }),
        context(),
        makeShellTestAccessGate({ selectableLegalEntityIds: [beta.legalEntityId] }),
      ),
    ).toEqual(beta);
    const forbidden = yield* Effect.flip(
      provideSelectionServices(
        validateAuthorizedLegalEntity({ legalEntityId: beta.legalEntityId, scope }),
        context(),
        makeShellTestAccessGate({ selectableLegalEntityIds: [alpha.legalEntityId] }),
      ),
    );
    expect(Predicate.isTagged(forbidden, 'LegalEntitySelectionForbiddenError')).toBe(true);
  }),
);

it.effect('replaces stale A only with the sole currently selectable same-Tenant B', () =>
  Effect.gen(function* replacesStaleSelection() {
    for (const candidates of [[alpha, beta], [beta]]) {
      expect(
        yield* provideSelectionServices(
          resolveAuthorizedLegalEntities({ savedLegalEntityId: alpha.legalEntityId, scope }),
          context(candidates),
          makeShellTestAccessGate({ selectableLegalEntityIds: [beta.legalEntityId] }),
        ),
      ).toEqual({ available: [beta], selected: beta, state: 'selected' });
    }
  }),
);

it.effect('blocks stale A with no current grant and requires selection when several alternatives remain', () =>
  Effect.gen(function* boundsStaleSelection() {
    expect(
      yield* provideSelectionServices(
        resolveAuthorizedLegalEntities({ savedLegalEntityId: alpha.legalEntityId, scope }),
        context([beta]),
        makeShellTestAccessGate({}),
      ),
    ).toEqual({ available: [], state: 'access_blocked' });
    expect(
      yield* provideSelectionServices(
        resolveAuthorizedLegalEntities({ savedLegalEntityId: alpha.legalEntityId, scope }),
        context([alpha, beta, gamma]),
        makeShellTestAccessGate({ selectableLegalEntityIds: [beta.legalEntityId, gamma.legalEntityId] }),
      ),
    ).toEqual({ available: [beta, gamma], state: 'selection_required' });
  }),
);

it.effect('fails closed when the active Legal Entity provider is unavailable or returns foreign-Tenant records', () =>
  Effect.gen(function* rejectsInvalidCandidates() {
    const validContext = context();
    for (const listActiveForTenant of [
      () => Effect.fail(new LegalEntityContextUnavailableError({ reason: 'Fixture provider unavailable' })),
      (selectedTenant: string) =>
        classifyActiveLegalEntities(
          [{ ...beta, status: 'active', tenantId: '10000000-0000-4000-8000-000000000002' }],
          selectedTenant,
        ),
    ]) {
      const failure = yield* Effect.flip(
        provideSelectionServices(
          resolveAuthorizedLegalEntities({ savedLegalEntityId: alpha.legalEntityId, scope }),
          { ...validContext, listActiveForTenant },
          makeShellTestAccessGate({ selectableLegalEntityIds: [beta.legalEntityId] }),
        ),
      );
      expect(Predicate.isTagged(failure, 'LegalEntitySelectionUnavailableError')).toBe(true);
    }
  }),
);
