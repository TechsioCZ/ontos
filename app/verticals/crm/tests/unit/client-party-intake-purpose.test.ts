import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { NodeCrypto, NodePath } from '@effect/platform-node';
import {
  bindActionTestServices,
  makeActionPreparationProbe,
  makeActionTestHarness,
} from '@app/core-runtime/testing/actions';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { makeAccessDecisionService } from '@app/core-runtime/access/enforcement';
import { AccessScopeIdSchema, LegalEntityIdSchema, TenantIdSchema } from '@app/core-runtime/access/ids';
import { DateTime, Effect, FileSystem, Layer, Option, Schema } from 'effect';
import { HttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';
import { intakeClientPartyAction } from '../../src/actions/intake-client-party.action.ts';
import { pendingClientIntakeRead } from '../../src/api/pending-client-intake.read.ts';
import { linkVerifiedIntakeParty } from '../../src/services/client-party-intake.ts';
import { PartyIntake } from '../../src/services/party-intake.ts';
import { IntakeClientPartyPayloadSchema } from '../../shared/actions/client-party-intake.ts';
import { EntityIdSchema } from '../../shared/domain/common.ts';
import { crmRegistration } from '../../vertical.registration.ts';
import { companyId, otherCompanyId, scope, state } from './search-fixtures.ts';
import { CrmStateSchema } from '../../shared/domain/state.ts';
import { clientIntakeOwnerFixture } from './client-party-intake-owner.fixture.ts';

const serviceId = '30000000-0000-4000-8000-000000000087';
const principal = {
  authBindingId: '40000000-0000-4000-8000-000000000087',
  authContextRef: 'api-key:crm-intake',
  authMethod: 'api_key' as const,
  legalEntityId: companyId,
  principalId: serviceId,
  tenantId: scope.tenantId,
};
const party = {
  counterpartyId: EntityIdSchema.make('registry-customer'),
  displayName: 'Verified customer',
  partyId: EntityIdSchema.make('registry-party'),
};

const gateFor = (kind: 'human' | 'service', bound: boolean) =>
  makeAccessDecisionService({
    authorityFor: () => ({
      readCells: () => Effect.succeed([]),
      readCompanyOwnership: () => Effect.succeed(true),
      readConfigureBases: () => Effect.succeed([]),
      readConnection: () => Effect.succeed(Option.none()),
      readScope: () =>
        Effect.succeed(
          Option.some({
            deadlines: [],
            holderDeadlines: [],
            scope: {
              _tag: 'LegalEntity',
              legalEntityId: LegalEntityIdSchema.make(companyId),
              tenantId: TenantIdSchema.make(scope.tenantId),
            },
            scopeId: AccessScopeIdSchema.make('50000000-0000-4000-8000-000000000087'),
            tenantId: TenantIdSchema.make(scope.tenantId),
          }),
        ),
      readTeamIds: () => Effect.succeed([]),
    }),
    check: { checkBulk: (items) => Effect.succeed(items.map(() => ({ permissionship: 'has' as const }))) },
    decisionLog: { record: () => Effect.void },
    legalEntities: { listCandidateIds: () => Effect.succeed([LegalEntityIdSchema.make(companyId)]) },
    principalKinds: { readKind: () => Effect.succeed(Option.some(kind)) },
    workloadBindings: {
      readWorkloadAuthority: () =>
        Effect.succeed({
          activeCompanyIds: new Set([LegalEntityIdSchema.make(companyId)]),
          workloadKeys: new Set(bound ? ['demo.crm.party-intake'] : []),
        }),
    },
  });

const intakeTestLayer = Layer.mergeAll(
  Layer.succeed(PartyIntake, {
    forRequest: () => ({
      identify: () => Effect.die('The bound native fixture must not perform registry identification'),
      reconcile: () => Effect.die('The bound native fixture must not run a second reconciliation'),
    }),
  }),
  NodeCrypto.layer,
  NodePath.layer,
  FileSystem.layerNoop({
    exists: () => Effect.die('The bound native fixture must not inspect files'),
    readFileString: () => Effect.die('The bound native fixture must not read configuration files'),
  }),
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die('The bound native fixture must not call HTTP')),
  ),
);

it.layer(intakeTestLayer)('CRM native intake purpose', (suite) => {
  for (const [kind, bound, expected] of [
    ['service', false, 'DENIED'],
    ['human', true, 'DENIED'],
    ['service', true, 'ALLOWED'],
  ] as const) {
    suite.effect(`purpose producers admit ${kind} bound=${bound} as ${expected}, not membership or a human Role`, () =>
      Effect.gen(function* machineAdmission() {
        const gate = gateFor(kind, bound);
        for (const registration of [intakeClientPartyAction, pendingClientIntakeRead]) {
          const result = yield* gate.decide({
            carrier: registration.descriptor,
            legalEntityScope: 'required',
            now: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-07T00:00:00Z')),
            scope: { ...principal, correlationId: 'purpose' },
          });
          expect(result.outcome).toBe(expected);
        }
      }),
    );
  }

  suite.effect(
    'actual native workload Action commits one verified link with original history/correlation and its own receipt identity',
    () =>
      Effect.gen(function* nativeIntake() {
        let current = state;
        let calls = 0;
        const gate = gateFor('service', true);
        const ownerFixture = yield* clientIntakeOwnerFixture(
          yield* Schema.decodeEffect(TrustedPrincipalContextSchema)(principal),
        );
        const preparationProbe = makeActionPreparationProbe(intakeClientPartyAction);
        const harness = yield* makeActionTestHarness({
          access: 'allowed',
          accessDecision: {
            decide: gate.decide,
            list: gate.list,
            selectableLegalEntities: () => Effect.succeed([LegalEntityIdSchema.make(companyId)]),
          },
          applicationComposition: ownerFixture.owner.applicationComposition,
          expectedDeployment: ownerFixture.owner.expectedDeployment,
          ownerRegistration: crmRegistration,
          preparationReads: [
            {
              execute: ({ params, scope: installed }) => {
                expect(params).toEqual([principal.tenantId, companyId, 1]);
                expect(installed).toEqual({ legalEntityId: companyId, tenantId: principal.tenantId });
                return Effect.succeed([{ revision: 0, state: Schema.encodeSync(CrmStateSchema)(state) }]);
              },
              sql: 'select "revision", "state" from "demo_crm"."crm_states" where (("demo_crm"."crm_states"."tenant_id" = $1) and ("demo_crm"."crm_states"."legal_entity_id" = $2)) limit $3',
            },
          ],
          services: [
            bindActionTestServices(intakeClientPartyAction, {
              link: (payload, invocationId) =>
                linkVerifiedIntakeParty(current, payload.clientId, party, {
                  invocationId,
                  principalId: serviceId,
                }).pipe(
                  Effect.map((next) => {
                    calls += 1;
                    current = next;
                    return { entityIds: [payload.clientId], revision: 1, status: 'linked' as const };
                  }),
                ),
            }),
          ],
        });
        const payload = yield* Schema.decodeUnknownEffect(IntakeClientPartyPayloadSchema)({
          clientId: 'client-1',
          expectedRevision: 0,
        });
        const input = preparationProbe.input({
          payload,
          principal: ownerFixture.principal,
          transport: { correlationId: 'native-intake', idempotencyKey: 'native-intake:1' },
        });
        const result = yield* harness.runtime.runAction(input).pipe(Effect.provide(ownerFixture.transport));
        expect(Option.isSome(preparationProbe.snapshot())).toBe(true);
        expect(harness.snapshot().preparationQueries).toHaveLength(1);
        expect(ownerFixture.calls).toEqual([
          '/auth/delegated/gateway-context',
          '/party-registry-api/reads/customer-list',
        ]);
        expect(result.status).toBe('linked');
        expect(current.clients.items[0]?.partyRef?.partyId).toBe(party.partyId);
        expect(current.clients.items[0]?.partyRef?.linkedBy).toBe(serviceId);
        expect(current.clients.events?.at(-1)?.kind).toBe('party_linked');
        expect(current.imports).toEqual(state.imports);
        expect(calls).toBe(1);
        expect(harness.snapshot().committed[0]?.actionKey).toBe('demo.crm.intake-client-party');
        expect(harness.snapshot().committed[0]?.transport.correlationId).toBe('native-intake');
        expect(current.clients.events?.at(-1)?.id).toBe(
          `${harness.snapshot().committed[0]?.actionInvocationId}-party-intake`,
        );
        expect(harness.snapshot().committed[0]?.evidence.outboxMessages).toHaveLength(1);
        const replay = yield* harness.runtime.runAction(input).pipe(Effect.flip);
        expect(replay._tag).toBe('ActionAlreadyCommitted');
        expect(ownerFixture.calls).toHaveLength(2);
        expect(harness.snapshot().preparationQueries).toHaveLength(1);
        expect(calls).toBe(1);
      }),
  );

  suite.effect(
    'original preparation rejects stale revisions and foreign client selectors before HTTP or a writer',
    () =>
      Effect.gen(function* deniedPreparation() {
        const ownerFixture = yield* clientIntakeOwnerFixture(
          yield* Schema.decodeEffect(TrustedPrincipalContextSchema)(principal),
        );
        const gate = gateFor('service', true);
        for (const [payload, expectedCode] of [
          [{ clientId: 'client-1', expectedRevision: 1 }, 'crm_revision_conflict'],
          [{ clientId: 'client-in-another-company', expectedRevision: 0 }, 'crm_not_found'],
        ] as const) {
          let writes = 0;
          const probe = makeActionPreparationProbe(intakeClientPartyAction);
          const harness = yield* makeActionTestHarness({
            access: 'allowed',
            accessDecision: {
              decide: gate.decide,
              list: gate.list,
              selectableLegalEntities: () => Effect.succeed([LegalEntityIdSchema.make(companyId)]),
            },
            applicationComposition: ownerFixture.owner.applicationComposition,
            expectedDeployment: ownerFixture.owner.expectedDeployment,
            ownerRegistration: crmRegistration,
            preparationReads: [
              {
                execute: ({ params, scope: installed }) => {
                  expect(params).toEqual([principal.tenantId, companyId, 1]);
                  expect(installed).toEqual({ legalEntityId: companyId, tenantId: principal.tenantId });
                  return Effect.succeed([{ revision: 0, state: Schema.encodeSync(CrmStateSchema)(state) }]);
                },
                sql: 'select "revision", "state" from "demo_crm"."crm_states" where (("demo_crm"."crm_states"."tenant_id" = $1) and ("demo_crm"."crm_states"."legal_entity_id" = $2)) limit $3',
              },
            ],
            services: [
              bindActionTestServices(intakeClientPartyAction, {
                link: () =>
                  Effect.sync(() => {
                    writes += 1;
                  }).pipe(Effect.andThen(Effect.die('Rejected preparation must not reach the bound writer'))),
              }),
            ],
          });
          const failure = yield* harness.runtime
            .runAction(
              probe.input({
                payload,
                principal: ownerFixture.principal,
                transport: { correlationId: 'native-intake', idempotencyKey: expectedCode },
              }),
            )
            .pipe(Effect.provide(ownerFixture.transport), Effect.flip);
          expect(failure).toMatchObject({ code: expectedCode });
          expect(probe.snapshot()).toEqual(Option.none());
          expect(harness.snapshot().preparationQueries).toHaveLength(1);
          expect(harness.snapshot().committed).toEqual([]);
          expect(ownerFixture.calls).toEqual([]);
          expect(writes).toBe(0);
        }
      }),
  );

  suite.effect('unrelated client and replacement of an existing link fail before changing owner state', () =>
    Effect.gen(function* unrelatedTarget() {
      const unrelated = yield* linkVerifiedIntakeParty(state, 'client-in-another-company', party, {
        invocationId: 'intake',
        principalId: serviceId,
      }).pipe(Effect.flip);
      expect(unrelated._tag).toBe('CrmNotFound');
      const linked = yield* linkVerifiedIntakeParty(state, 'client-1', party, {
        invocationId: 'intake',
        principalId: serviceId,
      });
      const replacement = yield* linkVerifiedIntakeParty(
        linked,
        'client-1',
        { ...party, partyId: EntityIdSchema.make('unrelated-party') },
        { invocationId: 'another', principalId: serviceId },
      ).pipe(Effect.flip);
      expect(replacement._tag).toBe('CrmReferenceIneligible');
      expect(state.clients.items[0]?.partyRef).toBeUndefined();
    }),
  );

  suite.effect(
    'purpose Read queries only id/link observations in its actual scoped company; a foreign company cannot supply the client',
    () =>
      Effect.gen(function* scopedPending() {
        for (const legalEntityId of [companyId, otherCompanyId]) {
          for (const clientIds of [undefined, [], ['client-1'], ['missing-client', 'another-client']]) {
            const trusted = { ...principal, correlationId: `pending:${legalEntityId}`, legalEntityId };
            const items =
              legalEntityId === companyId && (clientIds === undefined || clientIds.includes('client-1'))
                ? [{ id: 'client-1', linked: false }]
                : [];
            let queries = 0;
            const harness = yield* makeReadTestHarness({
              access: 'allowed',
              executeOwnerQuery: ({ params, scope: selected, sql }) => {
                queries += 1;
                expect(selected).toEqual({ legalEntityId, tenantId: principal.tenantId });
                expect(params).toEqual([...(clientIds ?? []), principal.tenantId, legalEntityId, 1]);
                let selector = "c->>'status' = 'active'";
                if (clientIds !== undefined) {
                  const placeholders = clientIds.map((_, index) => `$${index + 1}`).join(', ');
                  selector = clientIds.length === 0 ? 'false' : `c->>'id' in (${placeholders})`;
                }
                expect(sql).toContain(`c where ${selector})`);
                expect(sql).toContain(
                  `where (("demo_crm"."crm_states"."tenant_id" = $${(clientIds?.length ?? 0) + 1}) and ("demo_crm"."crm_states"."legal_entity_id" = $${(clientIds?.length ?? 0) + 2}))`,
                );
                expect(sql).toContain("jsonb_build_object('id', c->>'id', 'linked',");
                expect(sql).toContain('counterpartyId');
                expect(sql).not.toContain('notes');
                return Effect.succeed(legalEntityId === companyId ? [{ items, revision: 1 }] : []);
              },
              operationTime: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-07T00:00:00Z')),
              ownerAuthorizationDecision: 'allowed',
              ownerRegistration: crmRegistration,
              scope: trusted,
            });
            const result = yield* harness.runtime.runRead({
              input: clientIds === undefined ? {} : { clientIds },
              principal: trusted,
              registration: pendingClientIntakeRead,
              transport: { correlationId: trusted.correlationId },
            });
            expect(result).toEqual({ items, revision: legalEntityId === companyId ? 1 : 0 });
            expect(queries).toBe(1);
          }
        }
      }),
  );
});
