import { crmClientEvidenceReference } from '../../src/services/crm-client-evidence.ts';
import { ActionRuntime, ReadPermissionDenied, collectAccessCatalog } from '@app/core-runtime';
import { NodeCrypto } from '@effect/platform-node';
import { makeAccessDecisionService } from '@app/core-runtime/access/enforcement';
import { AccessScopeIdSchema, LegalEntityIdSchema, TenantIdSchema } from '@app/core-runtime/access/ids';
import { trustVerifiedGatewayPrincipalContext } from '@app/core-runtime/auth/system-principal-context-provenance';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { makeOwnerApplicationCompositionFixture } from '@app/core-runtime/testing/module-contract';
import { DateTime, Effect, Option, Predicate, Result, Schema, Struct } from 'effect';
import { expect, it } from 'effect-rstest';
import { createCrmClientPartyAction } from '../../src/actions/create-crm-client-party.action.ts';
import { createPartyAction } from '../../src/actions/create-party.action.ts';
import { customerListRead } from '../../src/api/customer-list.read.ts';
import { counterpartyCustomerOnboardAction } from '../../src/actions/counterparty-customer-onboard.action.ts';
import { addContactPointAction } from '../../src/actions/add-contact-point.action.ts';
import { crmClientIntakeReviewRead } from '../../src/api/crm-client-intake-review.read.ts';
import { resolveDuplicateCandidateCreateAction } from '../../src/actions/resolve-duplicate-candidate-create.action.ts';
import { PartyCreateOutcomeSchema } from '../../shared/domain/identity-contracts.ts';
import { partyRegistryRegistration } from '../../vertical.registration.ts';

const tenantId = TenantIdSchema.make('10000000-0000-4000-8000-000000000001');
const legalEntityId = LegalEntityIdSchema.make('20000000-0000-4000-8000-000000000001');
const serviceId = '30000000-0000-4000-8000-000000000087';
const principal = {
  tenantId,
  legalEntityId,
  principalId: serviceId,
  authMethod: 'api_key' as const,
  authBindingId: '40000000-0000-4000-8000-000000000087',
  authContextRef: 'api-key:crm-intake',
};
const delegated = (compositionRevision: string, appId = 'crm') =>
  trustVerifiedGatewayPrincipalContext(
    { ...principal, correlationId: 'crm-party-intake' },
    compositionRevision,
    undefined,
    {
      appId,
      principalId: '30000000-0000-4000-8000-000000000088',
      buildMarker: 'crm-build',
    },
  );
const gateFor = (kind: 'service' | 'human', bound = true) =>
  makeAccessDecisionService({
    principalKinds: { readKind: () => Effect.succeed(Option.some(kind)) },
    workloadBindings: {
      readWorkloadAuthority: () =>
        Effect.succeed({
          activeCompanyIds: new Set([legalEntityId]),
          workloadKeys: new Set(bound ? ['demo.crm.party-intake'] : []),
        }),
    },
    authorityFor: () => ({
      readCompanyOwnership: (query) =>
        Effect.succeed(query.tenantId === tenantId && query.legalEntityId === legalEntityId),
      readScope: (query) =>
        Effect.succeed(
          query.tenantId !== tenantId || (query.legalEntityId !== undefined && query.legalEntityId !== legalEntityId)
            ? Option.none()
            : Option.some({
                tenantId,
                scopeId: AccessScopeIdSchema.make('50000000-0000-4000-8000-000000000087'),
                scope: { _tag: 'LegalEntity', tenantId, legalEntityId },
                deadlines: [],
                holderDeadlines: [],
              }),
        ),
      readCells: () => Effect.succeed([]),
      readConfigureBases: () => Effect.succeed([]),
      readConnection: () => Effect.succeed(Option.none()),
      readTeamIds: () => Effect.succeed([]),
    }),
    check: { checkBulk: (items) => Effect.succeed(items.map(() => ({ permissionship: 'has' as const }))) },
    decisionLog: { record: () => Effect.void },
    legalEntities: { listCandidateIds: () => Effect.succeed([legalEntityId]) },
  });
const candidate = {
  businessName: 'Owner-attested CRM client',
  partyType: 'ORGANIZATION',
  evidenceRefs: [crmClientEvidenceReference({ tenantId, legalEntityId }, 'client-1')],
  officialIdentifiers: [],
  provenance: { method: 'MANUAL_ENTRY', source: 'demo.crm.client-intake' },
  subjectEvidence: [
    {
      basis: 'DIRECT_INTERACTION',
      kind: 'ACTOR_ATTESTATION',
      evidenceRef: crmClientEvidenceReference({ tenantId, legalEntityId }, 'client-1'),
      subjectKey: crmClientEvidenceReference({ tenantId, legalEntityId }, 'client-1'),
      observedSubject: 'ORGANIZATION',
      statement: 'Exact CRM client entered by its authorized user',
    },
  ],
  validFrom: '2026-11-01T00:00:00Z',
};

it('purpose carriers use only the source-owned delegated workload and produce no human catalog permissions', () => {
  const descriptors = [createCrmClientPartyAction.descriptor, crmClientIntakeReviewRead.descriptor];
  for (const descriptor of descriptors) {
    expect(descriptor.accessActor).toMatchObject({
      callers: ['crm'],
      subject: 'workload',
      subjectWorkloads: ['demo.crm.party-intake'],
    });
    expect(descriptor.accessDeclaration).toBeUndefined();
    expect(descriptor.accessWorkload).toBeUndefined();
    expect(descriptor.accessFieldGroups ?? []).toEqual([]);
  }
  expect(collectAccessCatalog([{ descriptors, moduleId: 'party.registry' }])).toEqual(
    Result.succeed({ entries: [], findings: [] }),
  );
  expect(createPartyAction.descriptor.accessActor?.callers).toEqual(['commerce-customer-context']);
  expect(createPartyAction.descriptor.accessActor?.subject).toBe('identity');
});

it('client evidence is bounded, company-qualified and unambiguous for Unicode or delimiter-bearing local IDs', () => {
  const scope = { legalEntityId, tenantId };
  const reference = crmClientEvidenceReference(scope, 'client:1');
  expect(reference).toMatch(/^crm-client:[a-f0-9]{64}$/u);
  expect(crmClientEvidenceReference(scope, 'client:1')).toBe(reference);
  expect(
    crmClientEvidenceReference({ ...scope, legalEntityId: '20000000-0000-4000-8000-000000000099' }, 'client:1'),
  ).not.toBe(reference);
  expect(crmClientEvidenceReference(scope, '\uD800')).not.toBe(crmClientEvidenceReference(scope, '\uFFFD'));
  expect(crmClientEvidenceReference(scope, 'a:b')).not.toBe(crmClientEvidenceReference(scope, 'a'));
});

it('client evidence keeps its published wire value (SHA-256 of the length-prefixed identity)', () => {
  const scope = {
    legalEntityId: '20000000-0000-4000-8000-000000000002',
    tenantId: '10000000-0000-4000-8000-000000000001',
  };
  expect(crmClientEvidenceReference(scope, 'client-1')).toBe(
    'crm-client:9e9d4e97b6d8eea9ed6f17c9dcd980139968d0027cc56540ae1a73b3fc8164f3',
  );
  expect(crmClientEvidenceReference(scope, '')).toBe(
    'crm-client:1418954ede073509d70cf5d0ef4771d720a2fe3540fcf8b1e8411e92ea304709',
  );
  expect(crmClientEvidenceReference(scope, '\uD800')).toBe(
    'crm-client:98deea69df7f27fa95395376856dd219f1104a421389392249ea51946e5c1f99',
  );
  expect(crmClientEvidenceReference(scope, 'Pekárna Novák 🍞')).toBe(
    'crm-client:214525b5d8f3f0b8a6adc930331b72ac9c698643322d270fa62a5dac4638272b',
  );
  expect(crmClientEvidenceReference(scope, 'x'.repeat(300))).toBe(
    'crm-client:a43944894e886636fdad94be331d9bb5a14c6719341a7518d628f02c348eb5cb',
  );
});

it.layer(NodeCrypto.layer)('CRM intake workload admission', (suite) => {
  suite.effect(
    'native purpose Action and Read deny humans, unbound workload and module-less service before owner work',
    () =>
      Effect.gen(function* exclusiveNativeAdmission() {
        const owner = yield* makeOwnerApplicationCompositionFixture({ ownerRegistration: partyRegistryRegistration });
        const { revision } = owner.snapshot.composition;
        for (const [kind, bound, requestScope] of [
          ['human', true, delegated(revision)],
          ['service', false, delegated(revision)],
          ['service', true, { ...principal, correlationId: 'direct-key' }],
          ['service', true, delegated(revision, 'other-module')],
        ] as const) {
          const gate = gateFor(kind, bound);
          const accessDecision = {
            decide: gate.decide,
            list: gate.list,
            selectableLegalEntities: () => Effect.succeed([legalEntityId]),
          };
          const harness = yield* makeActionTestHarness({
            ...owner,
            accessDecision,
            services: [
              bindActionTestServices(createCrmClientPartyAction, {
                createOrMatch: () => Effect.die('An inadmissible subject must never reach Party creation'),
              }),
            ],
          });
          const refused = yield* harness.runtime
            .runAction({
              payload: { candidate, clientId: 'client-1', sourceScope: { legalEntityId, tenantId } },
              principal: requestScope,
              registration: createCrmClientPartyAction,
              transport: { correlationId: 'exclusive-negative', idempotencyKey: `exclusive-${kind}-${bound}` },
            })
            .pipe(Effect.flip);
          expect(Predicate.isTagged(refused, 'ActionPermissionDenied')).toBe(true);
          expect(harness.snapshot().committed).toEqual([]);
          expect(harness.snapshot().transactionCount).toBe(0);
          const reads = yield* makeReadTestHarness({
            ...owner,
            accessDecision,
            compositionRevision: revision,
            executeOwnerQuery: () => Effect.die('An inadmissible subject must never query Party review data'),
            operationTime: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-07T00:00:00Z')),
            scope: requestScope,
          });
          const deniedRead = yield* reads.runtime
            .runRead({
              input: {
                caseRef: {
                  moduleId: 'party.registry',
                  resourceType: 'party.registry.duplicate-candidate-case',
                  resourceId: '60000000-0000-4000-8000-000000000001',
                  tenantId,
                },
                clientId: 'client-1',
                decisionRef: {
                  moduleId: 'party.registry',
                  resourceType: 'party.registry.party-match-decision',
                  resourceId: '60000000-0000-4000-8000-000000000002',
                  tenantId,
                },
                sourceScope: { legalEntityId, tenantId },
              },
              principal: requestScope,
              registration: crmClientIntakeReviewRead,
              transport: { correlationId: 'exclusive-negative' },
            })
            .pipe(
              Effect.provideService(ActionRuntime, {
                resolveActionCommit: () => Effect.die('Denied review must not inspect native commit history'),
                resolveActionExecution: () => Effect.die('Denied review must not inspect execution history'),
                runAction: () => Effect.die('Denied review must not run an Action'),
              }),
              Effect.flip,
            );
          expect(Schema.is(ReadPermissionDenied)(deniedRead), deniedRead.reason).toBe(true);
        }
      }),
  );
  suite.effect(
    'bound workload plus the actual CRM module is required; no broadened human, direct-key or unrelated-module admission',
    () =>
      Effect.gen(function* admission() {
        const owner = yield* makeOwnerApplicationCompositionFixture({ ownerRegistration: partyRegistryRegistration });
        const { revision } = owner.snapshot.composition;
        const registrations = [
          createCrmClientPartyAction,
          customerListRead,
          counterpartyCustomerOnboardAction,
          addContactPointAction,
          crmClientIntakeReviewRead,
          resolveDuplicateCandidateCreateAction,
        ];
        for (const registration of registrations) {
          const question = {
            carrier: registration.descriptor,
            legalEntityScope: 'required' as const,
            scope: delegated(revision),
            now: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-07T00:00:00Z')),
          };
          expect((yield* gateFor('service').decide(question)).outcome).toBe('ALLOWED');
          expect((yield* gateFor('service', false).decide(question)).outcome).toBe('DENIED');
          expect((yield* gateFor('human').decide(question)).outcome).toBe('DENIED');
          expect(
            (yield* gateFor('service').decide({ ...question, scope: { ...principal, correlationId: 'direct-key' } }))
              .outcome,
          ).toBe('DENIED');
          expect(
            (yield* gateFor('service').decide({ ...question, scope: delegated(revision, 'other-module') })).outcome,
          ).toBe('DENIED');
        }
        expect(createPartyAction.descriptor.accessActor?.callers).toEqual(['commerce-customer-context']);
      }),
  );

  suite.effect(
    'purpose Create uses the original native business handler, result and outbox, and rejects unrelated client evidence',
    () =>
      Effect.gen(function* nativeCreate() {
        const owner = yield* makeOwnerApplicationCompositionFixture({ ownerRegistration: partyRegistryRegistration });
        const result = yield* Schema.decodeUnknownEffect(PartyCreateOutcomeSchema)({
          outcome: 'CREATED',
          partyRef: {
            moduleId: 'party.registry',
            resourceType: 'party.registry.party',
            tenantId,
            resourceId: '60000000-0000-4000-8000-000000000001',
          },
          decisionRef: {
            moduleId: 'party.registry',
            resourceType: 'party.registry.party-match-decision',
            tenantId,
            resourceId: '60000000-0000-4000-8000-000000000002',
          },
        });
        let created = 0;
        const gate = gateFor('service');
        const harness = yield* makeActionTestHarness({
          ...owner,
          access: 'allowed',
          accessDecision: {
            decide: gate.decide,
            list: gate.list,
            selectableLegalEntities: () => Effect.succeed([legalEntityId]),
          },
          services: [
            bindActionTestServices(createCrmClientPartyAction, {
              createOrMatch: () =>
                Effect.sync(() => {
                  created += 1;
                  return result;
                }),
            }),
          ],
        });
        const payload = { candidate, clientId: 'client-1', sourceScope: { tenantId, legalEntityId } };
        const input = {
          principal: delegated(owner.snapshot.composition.revision),
          payload,
          registration: createCrmClientPartyAction,
          transport: { correlationId: 'crm-party-intake', idempotencyKey: 'crm-party-intake:1' },
        };
        const stale = yield* harness.runtime
          .runAction({
            ...input,
            principal: delegated('a'.repeat(64)),
            transport: { correlationId: 'stale-composition', idempotencyKey: 'crm-party-intake:stale' },
          })
          .pipe(Effect.flip);
        expect(Predicate.isTagged(stale, 'ActionTransactionError')).toBe(true);
        expect(created).toBe(0);
        expect(harness.snapshot().transactionCount).toBe(0);
        expect(harness.snapshot().invocations).toHaveLength(1);
        expect(harness.snapshot().invocations[0]).toMatchObject({
          actionKey: 'party.registry.create-crm-client-party',
          completedAt: null,
          idempotencyKey: 'crm-party-intake:stale',
          legalEntityId,
          principalId: serviceId,
          status: 'received',
          tenantId,
        });
        expect(harness.snapshot().committed).toEqual([]);
        expect(yield* harness.runtime.runAction(input)).toEqual(result);
        expect(created).toBe(1);
        expect(harness.snapshot().committed[0]?.actionKey).toBe('party.registry.create-crm-client-party');
        expect(harness.snapshot().committed[0]?.evidence.outboxMessages).toHaveLength(1);
        const bad = yield* harness.runtime
          .runAction({
            ...input,
            payload: { ...payload, clientId: 'unrelated-client' },
            transport: { correlationId: 'bad-client', idempotencyKey: 'crm-party-intake:bad' },
          })
          .pipe(Effect.flip);
        expect(Predicate.isTagged(bad, 'PartyEvidenceInsufficient')).toBe(true);
        expect(created).toBe(1);
        const foreign = yield* harness.runtime
          .runAction({
            ...input,
            payload: { ...payload, sourceScope: { tenantId, legalEntityId: '20000000-0000-4000-8000-000000000099' } },
            transport: { correlationId: 'foreign-company', idempotencyKey: 'crm-party-intake:foreign' },
          })
          .pipe(Effect.flip);
        expect(Predicate.isTagged(foreign, 'PartyEvidenceInsufficient')).toBe(true);
        expect(created).toBe(1);
        const unattested = yield* harness.runtime
          .runAction({
            ...input,
            payload: { ...payload, candidate: Struct.omit(candidate, ['subjectEvidence']) },
            transport: { correlationId: 'missing-attestation', idempotencyKey: 'crm-party-intake:unattested' },
          })
          .pipe(Effect.flip);
        expect(Predicate.isTagged(unattested, 'PartyEvidenceInsufficient')).toBe(true);
        expect(created).toBe(1);
      }),
  );
});
