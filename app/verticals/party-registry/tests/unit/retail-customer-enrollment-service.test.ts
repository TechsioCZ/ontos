import { ActionRuntime, TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime/operations/context';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT } from '@app/party-registry-identity-contracts';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Deferred, Effect, Exit, Fiber, Layer, Predicate, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

import {
  RetailEnrollmentEvidenceSchema,
  RetailEnrollmentSubjectSchema,
} from '../../shared/actions/accept-retail-enrollment-evidence.ts';
import { EnrollRetailCustomerPayloadSchema } from '../../shared/actions/enroll-retail-customer.ts';
import { OwnedRetailPartyResultRequestSchema } from '../../shared/apis/owned-retail-party-result.ts';
import {
  PartyCandidateSchema,
  PartyCreateOutcomeSchema,
  PartyEvidenceEvaluationSchema,
  PartySchema,
} from '../../shared/domain/identity-contracts.ts';
import { createPartyAction } from '../../src/actions/create-party.action.ts';
import { updatePartyAction } from '../../src/actions/update-party.action.ts';
import { partyRelations } from '../../src/db/schema.ts';
import { evaluatePartySubjectEvidence } from '../../src/policies/create-party-without-strong-identifier.policy.ts';
import { tenantIdentityWriteLockKey } from '../../src/services/party-identifier-claim.service.ts';
import { retailCustomerEnrollmentService } from '../../src/services/retail-customer-enrollment.service.ts';
import { partyRegistryBackendRegistration } from '../../vertical.runtime-declaration.ts';

const TENANT = '10000000-0000-4000-8000-000000000001';
const COMPANY = '20000000-0000-4000-8000-000000000001';
const PRINCIPAL = '30000000-0000-4000-8000-000000000001';
const PARTY = '40000000-0000-4000-8000-000000000001';
const DECISION = '50000000-0000-4000-8000-000000000001';
const CASE = '60000000-0000-4000-8000-000000000001';
const OTHER = '90000000-0000-4000-8000-000000000001';
const KEY = 'retail-create-exact-idempotency';
const timestamp = '2026-11-20T00:00:00.000Z';
interface ScopeOverrides {
  readonly legalEntityId?: OperationalScope['legalEntityId'];
  readonly principalId?: OperationalScope['principalId'];
  readonly tenantId?: OperationalScope['tenantId'];
}
const scopeOf = (overrides: ScopeOverrides = {}): OperationalScope => ({
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)(
    Object.fromEntries(
      Object.entries({
        authBindingId: '70000000-0000-4000-8000-000000000001',
        authContextRef: 'retail-owner-proof-runtime',
        authMethod: 'api_key',
        legalEntityId: COMPANY,
        principalId: PRINCIPAL,
        tenantId: TENANT,
        ...overrides,
      }).filter(([, value]) => value !== undefined),
    ),
  ),
  correlationId: 'retail-owner-proof-runtime',
});
const scope = scopeOf();
const evidence = Schema.decodeUnknownSync(RetailEnrollmentEvidenceSchema)({
  authenticationNamespaceId: 'ontos.commerce.portal.better-auth.v1',
  candidateEvidenceRef: '80000000-0000-4000-8000-000000000001',
  emailOwnership: 'VERIFIED',
  enrollmentAttemptId: '81000000-0000-4000-8000-000000000001',
  journey: 'RETAIL_SELF_ENROLLMENT',
  providerOwnerInvocationId: '82000000-0000-4000-8000-000000000001',
  providerSubjectId: 'exact-retail-provider-subject',
  sellingLegalEntityId: COMPANY,
  tenantId: TENANT,
});
const evidenceSubject = Schema.decodeUnknownSync(RetailEnrollmentSubjectSchema)(evidence);
const attestation = {
  basis: 'DIRECT_INTERACTION',
  evidenceRef: evidence.candidateEvidenceRef,
  kind: 'ACTOR_ATTESTATION',
  observedSubject: 'PERSON',
  statement: 'The exact retail subject enrolled directly',
  subjectKey: evidence.providerSubjectId,
};
const candidateJson = {
  evidenceRefs: [evidence.candidateEvidenceRef],
  firstName: 'Retail',
  lastName: 'Customer',
  officialIdentifiers: [],
  partyType: 'PERSON',
  provenance: { method: 'commerce.portal-enrollment.self-enrollment', source: 'commerce.customer-context' },
  subjectEvidence: [attestation],
  validFrom: timestamp,
};
const evaluationJson = Schema.encodeSync(PartyEvidenceEvaluationSchema)(
  evaluatePartySubjectEvidence(Schema.decodeUnknownSync(PartyCandidateSchema)(candidateJson)),
);
const partyRef = {
  moduleId: 'party.registry',
  resourceId: PARTY,
  resourceType: 'party.registry.party',
  tenantId: TENANT,
};
const outcomeOf = (ambiguous = false) =>
  Schema.decodeUnknownSync(PartyCreateOutcomeSchema)({
    decisionRef: {
      moduleId: 'party.registry',
      resourceId: DECISION,
      resourceType: 'party.registry.party-match-decision',
      tenantId: TENANT,
    },
    ...(ambiguous
      ? {
          caseRef: {
            moduleId: 'party.registry',
            resourceId: CASE,
            resourceType: 'party.registry.duplicate-candidate-case',
            tenantId: TENANT,
          },
          outcome: 'AMBIGUOUS',
        }
      : { outcome: 'CREATED', partyRef }),
  });

interface OwnerStoreOptions {
  readonly alias?: boolean;
  readonly ambiguous?: boolean;
  readonly archived?: boolean;
  readonly decisionMissing?: boolean;
  readonly evaluation?: typeof PartyEvidenceEvaluationSchema.Encoded;
  readonly operation?: string;
  readonly partyMissing?: boolean;
  readonly partyType?: string;
}
interface OwnerQuery {
  readonly table: string;
  readonly params: readonly unknown[];
}

/** Bounded owner reads and the native identity fence; Drizzle and owner persistence stay real. */
const makeOwnerStore = (invocationId: string, input: OwnerStoreOptions = {}) =>
  Effect.gen(function* makeStore() {
    const queries: OwnerQuery[] = [];
    const decision = {
      action_invocation_id: invocationId,
      candidate_case_id: input.ambiguous === true ? CASE : null,
      candidate_fingerprint: 'a'.repeat(64),
      committed_create_outcome: input.ambiguous === true ? 'AMBIGUOUS' : 'CREATED',
      decided_at: timestamp,
      evidence_evaluation: input.evaluation ?? evaluationJson,
      evidence_explanation: [],
      match_decision_id: DECISION,
      match_rule_version: 'party-match.v1',
      operation: input.operation ?? 'CREATE',
      outcome: input.ambiguous === true ? 'AMBIGUOUS' : 'CREATED',
      party_id: input.ambiguous === true ? null : PARTY,
      tenant_id: TENANT,
    };
    const tables: ReadonlyMap<string, readonly Schema.JsonObject[]> = new Map(
      Object.entries({
        duplicate_candidate_case_parties: [],
        duplicate_candidate_cases:
          input.ambiguous === true
            ? [
                {
                  candidate_case_id: CASE,
                  lifecycle_state: 'OPEN',
                  resolution_action_invocation_id: null,
                  resolution_outcome: null,
                  selected_party_id: null,
                  tenant_id: TENANT,
                },
              ]
            : [],
        parties:
          input.partyMissing === true
            ? []
            : [
                {
                  archived_at: input.archived === true ? timestamp : null,
                  current_type: input.partyType ?? 'PERSON',
                  party_id: PARTY,
                  tenant_id: TENANT,
                },
                { archived_at: null, current_type: 'PERSON', party_id: OTHER, tenant_id: TENANT },
              ],
        party_aliases:
          input.alias === true ? [{ alias_party_id: PARTY, canonical_party_id: OTHER, tenant_id: TENANT }] : [],
        party_create_source_receipts: [],
        party_match_decisions: input.decisionMissing === true ? [] : [decision],
      }),
    );
    const execute = (sql: string, params: readonly unknown[]) =>
      Effect.sync(() => {
        if (
          sql ===
          'select pg_advisory_xact_lock(hashtextextended($1, 0)) from (values (1)) as party_identity_lock_anchor(value)'
        ) {
          queries.push({ params, table: 'identity_write_lock' });
          return [{ '0': null }];
        }
        const parsed = /^select (?<projection>.+?) from "[^"]+"\."(?<table>[^"]+)"/u.exec(sql);
        const { projection: selectedColumns, table } = parsed?.groups ?? {};
        if (selectedColumns === undefined || table === undefined) {
          throw new Error('The owner fixture only supports bounded SELECTs');
        }
        const projection = selectedColumns
          .split(', ')
          .map((column) => [...column.matchAll(/"(?<column>[^"]+)"/gu)].at(-1)?.groups?.['column']);
        queries.push({ params, table });
        const rows = tables.get(table);
        if (rows === undefined) {
          throw new Error(`Unexpected owner table: ${table}`);
        }
        const conditions = [...sql.matchAll(/"(?<column>[^"]+)" = \$(?<index>\d+)/gu)];
        return rows
          .filter((row) =>
            conditions.every(({ groups }) => {
              const { column, index } = groups ?? {};
              return column !== undefined && index !== undefined && row[column] === params[Number(index) - 1];
            }),
          )
          .map((row) =>
            Object.fromEntries(
              projection.map((column, index) => [String(index), column === undefined ? undefined : row[column]]),
            ),
          );
      });
    const services = yield* Layer.build(
      scriptedPgClientLayer(Effect.succeed(testSqlConnection(execute))).pipe(Layer.provideMerge(Reactivity.layer)),
    );
    const database = yield* makeWithDefaults({ relations: partyRelations }).pipe(Effect.provideContext(services));
    return { database, queries };
  });

const makeCommittedCreate = (input: { readonly access?: 'allowed' | 'denied'; readonly ambiguous?: boolean } = {}) =>
  Effect.gen(function* commitOriginal() {
    const harness = yield* makeActionTestHarness({
      access: input.access ?? 'allowed',
      databaseIdentities: PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT,
      ownerRegistration: partyRegistryBackendRegistration,
      services: [
        bindActionTestServices(createPartyAction, { createOrMatch: () => Effect.succeed(outcomeOf(input.ambiguous)) }),
      ],
    });
    const exit = yield* harness.runtime
      .runAction({
        payload: { candidate: candidateJson },
        principal: scope,
        registration: createPartyAction,
        transport: { correlationId: scope.correlationId, idempotencyKey: KEY },
      })
      .pipe(Effect.exit);
    const [invocation] = harness.snapshot().invocations;
    expect(Exit.isSuccess(exit)).toBe(input.access !== 'denied');
    if (invocation === undefined) {
      return yield* Effect.die('The native runtime did not reserve an invocation');
    }
    return { exit, harness, invocationId: invocation.actionInvocationId };
  });
const payloadOf = (invocationId: string, overrides: Partial<typeof EnrollRetailCustomerPayloadSchema.Encoded> = {}) =>
  Schema.decodeUnknownSync(EnrollRetailCustomerPayloadSchema)({
    email: 'retail@example.test',
    evidence,
    originalInvocationId: invocationId,
    ...overrides,
  });
const lookupOf = (overrides: Partial<typeof OwnedRetailPartyResultRequestSchema.Encoded> = {}) =>
  Schema.decodeUnknownSync(OwnedRetailPartyResultRequestSchema)({
    evidence: evidenceSubject,
    idempotencyKey: KEY,
    ...overrides,
  });
const makeFixture = (input: OwnerStoreOptions = {}) =>
  Effect.gen(function* fixture() {
    const original = yield* makeCommittedCreate(input);
    const store = yield* makeOwnerStore(original.invocationId, input);
    const service = yield* retailCustomerEnrollmentService(store.database, scope).pipe(
      Effect.provideService(ActionRuntime, original.harness.runtime),
    );
    return { ...original, ...store, service };
  });

it('accepts subject-only recovery without claiming verified email while refusing it as write evidence', () => {
  expect(lookupOf().evidence).toEqual(evidenceSubject);
  expect(evidenceSubject).not.toHaveProperty('emailOwnership');
  for (const emailOwnership of [undefined, 'UNVERIFIED']) {
    expect(
      Schema.is(EnrollRetailCustomerPayloadSchema)({
        email: 'retail@example.test',
        evidence: { ...evidenceSubject, emailOwnership },
        originalInvocationId: OTHER,
      }),
    ).toBe(false);
  }
});

it.effect('recovers only the exact committed Create idempotency result without replaying owner writes', () =>
  Effect.gen(function* exactLookup() {
    const fixture = yield* makeFixture();
    expect(fixture.harness.snapshot().committed).toHaveLength(1);
    expect(yield* fixture.service.lookup(lookupOf())).toMatchObject({
      createResult: outcomeOf(),
      invocationId: fixture.invocationId,
      state: 'COMMITTED',
    });
    expect(fixture.queries[0]).toEqual({ table: 'party_match_decisions', params: [TENANT, fixture.invocationId, 1] });
    const queries = fixture.queries.length;
    expect(yield* fixture.service.lookup(lookupOf({ idempotencyKey: `${KEY}-different` }))).toMatchObject({
      state: 'NOT_STARTED',
    });
    expect(fixture.queries).toHaveLength(queries);
    expect(fixture.queries.some((query) => query.table === 'identity_write_lock')).toBe(false);
    expect(fixture.harness.snapshot().committed).toHaveLength(1);
  }),
);

it.effect('fences mutating proof with the native tenant identity key before reading the Party decision', () =>
  Effect.gen(function* fenceOwnedRetailParty() {
    const fixture = yield* makeFixture();
    expect(yield* fixture.service.prove(payloadOf(fixture.invocationId))).toEqual(partyRef);
    expect(fixture.queries.slice(0, 2)).toEqual([
      { params: [tenantIdentityWriteLockKey(TENANT)], table: 'identity_write_lock' },
      { params: [TENANT, fixture.invocationId, 1], table: 'party_match_decisions' },
    ]);
    expect(fixture.queries.filter((query) => query.table === 'identity_write_lock')).toHaveLength(1);
  }),
);

it.effect('proves a committed owned Create and derives its retained canonical PERSON reference', () =>
  Effect.gen(function* ownedPerson() {
    const fixture = yield* makeFixture();
    expect(yield* fixture.service.prove(payloadOf(fixture.invocationId))).toEqual(partyRef);
    expect(fixture.queries.some((query) => query.table === 'party_aliases')).toBe(true);
    expect(fixture.queries.some((query) => query.table === 'parties')).toBe(true);
  }),
);

const foreignOwnershipCases: readonly (readonly [string, ScopeOverrides])[] = [
  ['foreign principal', { principalId: OTHER }],
  ['foreign tenant', { tenantId: OTHER }],
  ['foreign company', { legalEntityId: OTHER }],
];
for (const [label, overrides] of foreignOwnershipCases) {
  it.effect(`rejects ${label} ownership before reading any owner decision`, () =>
    Effect.gen(function* foreignOwnership() {
      const fixture = yield* makeFixture();
      const foreignScope = scopeOf(overrides);
      const matchingEvidence = yield* Schema.decodeUnknownEffect(RetailEnrollmentEvidenceSchema)({
        ...evidence,
        tenantId: foreignScope.tenantId,
        sellingLegalEntityId: foreignScope.legalEntityId,
      });
      const service = yield* retailCustomerEnrollmentService(fixture.database, foreignScope).pipe(
        Effect.provideService(ActionRuntime, fixture.harness.runtime),
      );
      expect(
        Predicate.isTagged(
          yield* service.prove(payloadOf(fixture.invocationId, { evidence: matchingEvidence })).pipe(Effect.flip),
          'PartyEvidenceInsufficient',
        ),
      ).toBe(true);
      expect(yield* service.lookup(lookupOf({ evidence: matchingEvidence }))).toMatchObject({ state: 'NOT_STARTED' });
      expect(fixture.queries).toEqual([]);
    }),
  );
}

it.effect('rejects mismatched evidence scope before native resolution or owner lookup', () =>
  Effect.gen(function* wrongEvidenceScope() {
    const fixture = yield* makeFixture();
    for (const overrides of [{ tenantId: OTHER }, { sellingLegalEntityId: OTHER }]) {
      const mismatched = yield* Schema.decodeUnknownEffect(RetailEnrollmentEvidenceSchema)({
        ...evidence,
        ...overrides,
      });
      expect(
        Predicate.isTagged(
          yield* fixture.service.prove(payloadOf(fixture.invocationId, { evidence: mismatched })).pipe(Effect.flip),
          'PartyEvidenceInsufficient',
        ),
      ).toBe(true);
      expect(
        Predicate.isTagged(
          yield* fixture.service.lookup(lookupOf({ evidence: mismatched })).pipe(Effect.flip),
          'PartyEvidenceInsufficient',
        ),
      ).toBe(true);
    }
    expect(fixture.queries).toEqual([]);
  }),
);

it.effect('rejects an absent required company before owner lookup', () =>
  Effect.gen(function* requiredCompany() {
    const fixture = yield* makeFixture();
    const service = yield* retailCustomerEnrollmentService(
      fixture.database,
      scopeOf({ legalEntityId: undefined }),
    ).pipe(Effect.provideService(ActionRuntime, fixture.harness.runtime));
    expect(
      Predicate.isTagged(
        yield* service.prove(payloadOf(fixture.invocationId)).pipe(Effect.flip),
        'PartyEvidenceInsufficient',
      ),
    ).toBe(true);
    expect(fixture.queries).toEqual([]);
  }),
);

it.effect('refuses an unknown original invocation before reading owner data', () =>
  Effect.gen(function* unknownInvocation() {
    const fixture = yield* makeFixture();
    expect(
      Predicate.isTagged(yield* fixture.service.prove(payloadOf(OTHER)).pipe(Effect.flip), 'PartyEvidenceInsufficient'),
    ).toBe(true);
    expect(fixture.queries).toEqual([]);
  }),
);

it.effect('returns native REJECTED lookup and refuses proof for a permission-rejected Create', () =>
  Effect.gen(function* rejectedCreate() {
    const original = yield* makeCommittedCreate({ access: 'denied' });
    const store = yield* makeOwnerStore(original.invocationId);
    const service = yield* retailCustomerEnrollmentService(store.database, scope).pipe(
      Effect.provideService(ActionRuntime, original.harness.runtime),
    );
    expect(yield* service.lookup(lookupOf())).toMatchObject({ state: 'REJECTED' });
    expect(
      Predicate.isTagged(
        yield* service.prove(payloadOf(original.invocationId)).pipe(Effect.flip),
        'PartyEvidenceInsufficient',
      ),
    ).toBe(true);
    expect(store.queries).toEqual([]);
  }),
);

it.effect(
  'rejects a committed owned non-Create action and does not resolve its identical idempotency key as Create',
  () =>
    Effect.gen(function* wrongNativeAction() {
      const party = yield* Schema.decodeUnknownEffect(PartySchema)({
        archivedAt: null,
        businessName: null,
        createdAt: timestamp,
        displayName: 'Retail Customer',
        firstName: 'Retail',
        lastName: 'Customer',
        partyRef,
        partyType: 'PERSON',
        revision: 2,
        updatedAt: timestamp,
      });
      const harness = yield* makeActionTestHarness({
        access: 'allowed',
        databaseIdentities: PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT,
        ownerRegistration: partyRegistryBackendRegistration,
        services: [
          bindActionTestServices(updatePartyAction, { update: () => Effect.succeed({ _tag: 'found', value: party }) }),
        ],
      });
      yield* harness.runtime.runAction({
        payload: {
          expectedRevision: 1,
          firstName: 'Retail',
          partyRef,
          provenanceMethod: 'MANUAL',
          provenanceSource: 'test',
          validFrom: timestamp,
        },
        principal: scope,
        registration: updatePartyAction,
        transport: { correlationId: scope.correlationId, idempotencyKey: KEY },
      });
      const [invocation] = harness.snapshot().invocations;
      if (invocation === undefined) {
        return yield* Effect.die('The native runtime did not reserve an invocation');
      }
      const store = yield* makeOwnerStore(invocation.actionInvocationId);
      const service = yield* retailCustomerEnrollmentService(store.database, scope).pipe(
        Effect.provideService(ActionRuntime, harness.runtime),
      );
      expect(yield* service.lookup(lookupOf())).toMatchObject({ state: 'NOT_STARTED' });
      expect(
        Predicate.isTagged(
          yield* service.prove(payloadOf(invocation.actionInvocationId)).pipe(Effect.flip),
          'PartyEvidenceInsufficient',
        ),
      ).toBe(true);
      expect(store.queries).toEqual([]);
    }),
);

it.effect('returns native RUNNING without reading owner results until the Create commits', () =>
  Effect.gen(function* runningCreate() {
    const entered = yield* Deferred.make<boolean>();
    const release = yield* Deferred.make<boolean>();
    const harness = yield* makeActionTestHarness({
      access: 'allowed',
      databaseIdentities: PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT,
      ownerRegistration: partyRegistryBackendRegistration,
      services: [
        bindActionTestServices(createPartyAction, {
          createOrMatch: () =>
            Deferred.succeed(entered, true).pipe(Effect.andThen(Deferred.await(release)), Effect.as(outcomeOf())),
        }),
      ],
    });
    const fiber = yield* harness.runtime
      .runAction({
        payload: { candidate: candidateJson },
        principal: scope,
        registration: createPartyAction,
        transport: { correlationId: scope.correlationId, idempotencyKey: KEY },
      })
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    const [invocation] = harness.snapshot().invocations;
    if (invocation === undefined) {
      return yield* Effect.die('The native runtime did not reserve an invocation');
    }
    const store = yield* makeOwnerStore(invocation.actionInvocationId);
    const service = yield* retailCustomerEnrollmentService(store.database, scope).pipe(
      Effect.provideService(ActionRuntime, harness.runtime),
    );
    expect(yield* service.lookup(lookupOf())).toMatchObject({ state: 'RUNNING' });
    expect(
      Predicate.isTagged(
        yield* service.prove(payloadOf(invocation.actionInvocationId)).pipe(Effect.flip),
        'PartyEvidenceInsufficient',
      ),
    ).toBe(true);
    expect(store.queries).toEqual([]);
    yield* Deferred.succeed(release, true);
    yield* Fiber.join(fiber);
  }),
);

it.effect('allows unresolved AMBIGUOUS recovery but refuses to derive a customer Party', () =>
  Effect.gen(function* ambiguousCreate() {
    const fixture = yield* makeFixture({ ambiguous: true });
    expect(yield* fixture.service.lookup(lookupOf())).toMatchObject({
      createResult: outcomeOf(true),
      state: 'COMMITTED',
    });
    expect(
      Predicate.isTagged(
        yield* fixture.service.prove(payloadOf(fixture.invocationId)).pipe(Effect.flip),
        'PartyEvidenceInsufficient',
      ),
    ).toBe(true);
    expect(fixture.queries.some((query) => query.table === 'parties')).toBe(false);
  }),
);

const invalidRetainedCases: readonly (readonly [string, OwnerStoreOptions])[] = [
  ['an alias instead of the canonical Party', { alias: true }],
  ['an archived person', { archived: true }],
  ['a missing retained Party', { partyMissing: true }],
  ['an organization', { partyType: 'ORGANIZATION' }],
  ['an unresolved Party type', { partyType: 'UNRESOLVED' }],
  ['a missing original native decision', { decisionMissing: true }],
  ['a retained MATCH operation', { operation: 'MATCH' }],
];
for (const [label, input] of [
  ['an archived Party', { archived: true }],
  ['a Party that has become an alias', { alias: true }],
] as const) {
  it.effect(`recovers historical Create for ${label} but refuses a new customer write`, () =>
    Effect.gen(function* recoverHistoricalPartyWithoutNewWriteProof() {
      const fixture = yield* makeFixture(input);
      expect(yield* fixture.service.lookup(lookupOf())).toMatchObject({
        createResult: outcomeOf(),
        invocationId: fixture.invocationId,
        state: 'COMMITTED',
      });
      expect(fixture.queries.some((query) => query.table === 'identity_write_lock')).toBe(false);
      expect(
        Predicate.isTagged(
          yield* fixture.service.prove(payloadOf(fixture.invocationId)).pipe(Effect.flip),
          'PartyEvidenceInsufficient',
        ),
      ).toBe(true);
      expect(fixture.harness.snapshot().committed).toHaveLength(1);
    }),
  );
}

for (const [label, input] of invalidRetainedCases) {
  it.effect(`rejects ${label}`, () =>
    Effect.gen(function* invalidRetainedResult() {
      const fixture = yield* makeFixture(input);
      expect(
        Predicate.isTagged(
          yield* fixture.service.prove(payloadOf(fixture.invocationId)).pipe(Effect.flip),
          'PartyEvidenceInsufficient',
        ),
      ).toBe(true);
    }),
  );
}

const invalidProofCases: readonly (readonly [string, Schema.JsonObject])[] = [
  ['unsupported subject rule', { subjectEligibilityVersion: 'party-concrete-subject.v999' }],
  [
    'mixed manual evidence',
    {
      evidence: [
        attestation,
        {
          kind: 'MANUAL_DECLARATION',
          observedSubject: 'PERSON',
          statement: 'A manual person declaration',
          subjectKey: evidence.providerSubjectId,
        },
      ],
    },
  ],
  ['another provider subject', { evidence: [{ ...attestation, subjectKey: 'different-provider-subject' }] }],
];
for (const [label, overrides] of invalidProofCases) {
  it.effect(`rejects ${label} before following the native result`, () =>
    Effect.gen(function* invalidProof() {
      const decoded = yield* Schema.decodeUnknownEffect(PartyEvidenceEvaluationSchema)({
        ...evaluationJson,
        ...overrides,
      });
      const retained = yield* Schema.encodeEffect(PartyEvidenceEvaluationSchema)(decoded);
      const fixture = yield* makeFixture({ evaluation: retained });
      expect(
        Predicate.isTagged(
          yield* fixture.service.prove(payloadOf(fixture.invocationId)).pipe(Effect.flip),
          'PartyEvidenceInsufficient',
        ),
      ).toBe(true);
      expect(fixture.queries.map((query) => query.table)).toEqual(['identity_write_lock', 'party_match_decisions']);
    }),
  );
}
