import { NodeCrypto } from '@effect/platform-node';
import {
  ContextAccess,
  CoreSearchProjectionHitSchema,
  CoreSearchProjectionStore,
  CoreSearchQueryRuntime,
  ReadHandlerUnavailable,
  ReadPermissionDenied,
  ReadPermissionUnavailable,
  createCoreSearchQueryRuntime,
  makeInMemoryCoreSearchProjectionStore,
} from '@app/core-runtime';
import type { CoreSearchProjectionHit, OperationalScope } from '@app/core-runtime';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { ListAccessConditionSchema, evaluateListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import type { ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import { PrincipalIdSchema, RecordKeySchema } from '@app/core-runtime/access/ids';
import { makeTestBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import { attestOutboxWorkerHandlerContext } from '@app/core-runtime/testing/outbox';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { Cause, Context, DateTime, Effect, Exit, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { AgreementsStateSchema } from '../../shared/apis/records.ts';
import { SearchProjectionUnavailable } from '../../shared/domain/search-projection-error.ts';
import { contractsRead } from '../../src/search/contracts.provider.ts';
import { documentsRead } from '../../src/search/documents.provider.ts';
import {
  loadParentContractPredicate,
  requireSearchFields,
  requireSearchPredicate,
} from '../../src/services/search-access.ts';
import { buildSearchDocuments, loadCurrentSearchHits } from '../../src/services/search-projection.ts';
import type { LegalSearchAuthorization } from '../../src/services/search-projection.ts';
import { legalAgreementsRegistration } from '../../vertical.registration.ts';
import {
  allRecords,
  gateAnswer,
  gateWithList,
  recordKeys,
  retiredAccess,
  searchAuthorization,
} from '../support/search-access.ts';

const uid = (value: number) => `79000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
const tenantId = uid(1);
const legalEntityId = uid(2);
const scope: OperationalScope = {
  authBindingId: uid(3),
  authContextRef: 'better-auth-session:legal-search-access',
  authMethod: 'session',
  correlationId: 'legal-search-access',
  legalEntityId,
  principalId: uid(4),
  tenantId,
};
const at = DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-03T00:00:00.000Z'));
const contractIds = [uid(10), uid(11), uid(12)];
const documentIds = [uid(20), uid(21), uid(22)];
const contractRef = (resourceId: string) => ({
  moduleId: 'legal.agreements',
  resourceId,
  resourceType: 'legal.agreements.contract',
  tenantId,
});
const documentRef = (resourceId: string) => ({ ...contractRef(resourceId), resourceType: 'legal.agreements.document' });
const state = Schema.decodeUnknownSync(AgreementsStateSchema)({
  contracts: contractIds.map((id, index) => ({
    contractRef: contractRef(id),
    counterpartyRef: {
      moduleId: 'party.registry',
      resourceId: uid(30),
      resourceType: 'party.registry.counterparty',
      tenantId,
    },
    endDate: null,
    kind: 'OTHER',
    lifecycleState: 'ACTIVE',
    note: 'hidden contract note',
    occupancyRef: null,
    propertyRef: null,
    renewalNoticeDate: null,
    signatureState: 'SIGNED',
    startDate: '2026-11-01',
    subject: `Contract park ${index}`,
    supersedesContractRef: null,
    unitRef: null,
  })),
  documents: documentIds.map((id, index) => ({
    contractRef: index === 2 ? null : contractRef(contractIds[index] ?? uid(99)),
    createdAt: '2026-11-01T00:00:00.000Z',
    documentRef: documentRef(id),
    fileName: 'park.pdf',
    kind: 'OTHER',
    lifecycleState: 'FINAL',
    signedBy: 'hidden signatory',
    signedDocumentReference: 'hidden signed reference',
    signedOn: '2026-11-01',
    title: `Document park ${index}`,
    updatedAt: '2026-11-01T00:00:00.000Z',
  })),
});
const currentDocuments = () =>
  buildSearchDocuments({ companies: [{ legalEntityId, state }], projectionVersion: '1', tenantId }, '2026-11-03');
const resource = (kind: 'contract' | 'document') => `legal.agreements.${kind}`;
const conjunction: ListAccessPredicate = {
  groups: [
    {
      clauses: [
        { conditions: [{ _tag: 'RecordKeyIn', recordKeys: [RecordKeySchema.make(uid(20))] }] },
        { conditions: [{ _tag: 'RecordKeyIn', recordKeys: [RecordKeySchema.make(uid(21))] }] },
      ],
    },
    {
      clauses: [
        {
          conditions: [
            { _tag: 'AllInScope' },
            { _tag: 'RecordKeyIn', recordKeys: [RecordKeySchema.make(uid(21)), RecordKeySchema.make(uid(22))] },
          ],
        },
      ],
    },
  ],
};
const unsupported: readonly ListAccessPredicate[] = [
  {
    groups: [
      {
        clauses: [
          {
            conditions: [
              {
                _tag: 'AssignedTo',
                holder: { _tag: 'Principal', principalId: PrincipalIdSchema.make(scope.principalId) },
              },
            ],
          },
        ],
      },
    ],
  },
  {
    groups: [
      {
        clauses: [
          {
            conditions: [
              {
                _tag: 'EntrustedTo',
                holder: { _tag: 'Principal', principalId: PrincipalIdSchema.make(scope.principalId) },
              },
            ],
          },
        ],
      },
    ],
  },
  {
    groups: [
      {
        clauses: [
          {
            conditions: [
              Schema.decodeUnknownSync(ListAccessConditionSchema)({ _tag: 'TeamMemberOf', teamIds: [uid(40)] }),
            ],
          },
        ],
      },
    ],
  },
  {
    groups: [
      {
        clauses: [
          {
            conditions: [
              Schema.decodeUnknownSync(ListAccessConditionSchema)({
                _tag: 'AmountWithinCeiling',
                ceiling: { currency: 'CZK', limitMinor: 100 },
              }),
            ],
          },
        ],
      },
    ],
  },
];

/** A malformed adapter response remains typed at its port; the receiving owner must decode it. */
const predicateWithGroups = (groups: Schema.Json): ListAccessPredicate =>
  new Proxy(allRecords, { get: (_target, key) => (key === 'groups' ? groups : undefined) });
const malformed: readonly ListAccessPredicate[] = [
  predicateWithGroups(null),
  predicateWithGroups([{ clauses: [] }]),
  predicateWithGroups([{ clauses: [{ conditions: [] }] }]),
  predicateWithGroups([{ clauses: [{ conditions: [{ _tag: 'RecordKeyIn', recordKeys: [] }] }] }]),
  predicateWithGroups([{ clauses: [{ conditions: [{ _tag: 'AllInScope', extra: 'unknown' }] }] }]),
  predicateWithGroups([{ clauses: [{ conditions: [{ _tag: 'LegacyResourcePermission' }] }] }]),
];

const observeAuthorizedCandidates = (hits: readonly CoreSearchProjectionHit[]) =>
  Effect.sync(() => {
    expect(hits.map(({ ref }) => ref.resourceId)).toEqual([uid(21)]);
    expect(hits.some(({ ref }) => ref.resourceId === uid(20))).toBe(false);
  });

for (const [index, predicate] of [...unsupported, ...malformed].entries()) {
  it.effect(`refuses unsupported or malformed own and independent parent predicate ${index}`, () =>
    Effect.gen(function* invalidPredicate() {
      expect(Schema.is(SearchProjectionUnavailable)(yield* requireSearchPredicate(predicate).pipe(Effect.flip))).toBe(
        true,
      );
      const error = yield* loadParentContractPredicate(scope, contractsRead).pipe(
        Effect.provideService(AccessDecisionGate, gateAnswer('ALLOWED', predicate)),
        Effect.flip,
      );
      expect(Schema.is(SearchProjectionUnavailable)(error)).toBe(true);
    }),
  );
}

it.effect('requires explicit row and field evidence, including missing parent ALLOWED predicates', () =>
  Effect.gen(function* missingEvidence() {
    const incomplete: Partial<LegalSearchAuthorization> = {};
    expect(
      Schema.is(SearchProjectionUnavailable)(yield* requireSearchPredicate(incomplete.listAccess).pipe(Effect.flip)),
    ).toBe(true);
    for (const paths of [undefined, [['title']], [['signedBy']]]) {
      expect(Schema.is(SearchProjectionUnavailable)(yield* requireSearchFields(paths).pipe(Effect.flip))).toBe(true);
    }
    const missing = gateWithList((input) =>
      gateAnswer()
        .list(input)
        .pipe(Effect.map(({ decision }) => ({ decision }))),
    );
    const failure = yield* loadParentContractPredicate(scope, contractsRead).pipe(
      Effect.provideService(AccessDecisionGate, missing),
      Effect.flip,
    );
    expect(Schema.is(SearchProjectionUnavailable)(failure)).toBe(true);
  }),
);

it.effect('matches canonical AND-of-OR predicates and passes their exact intersection before index observation', () =>
  Effect.gen(function* combinedPredicates() {
    const documents = yield* currentDocuments();
    let observations = 0;
    const result = yield* loadCurrentSearchHits(scope, 'legal.agreements.document', { query: 'park' }, state, {
      ...searchAuthorization,
      listAccess: conjunction,
    }).pipe(
      Effect.provideService(ContextAccess, retiredAccess),
      Effect.provideService(AccessDecisionGate, gateAnswer('ALLOWED', recordKeys(uid(11)))),
      Effect.provideService(CoreSearchQueryRuntime, {
        search: (_input, requester, authorization) => {
          observations += 1;
          expect(requester).toBe(scope);
          const predicate = authorization?.listAccess;
          expect(predicate).toBeDefined();
          if (predicate === undefined) {
            return Effect.die('The owner must authorize the Core query before it observes candidates');
          }
          expect(
            documentIds.filter((key) =>
              evaluateListAccessPredicate(predicate, { recordKey: RecordKeySchema.make(key), teamIds: [] }),
            ),
          ).toEqual([uid(21)]);
          // An adversarial index may return unauthorized rows anyway. Postquery checks must match.
          return Effect.succeed(documents.filter(({ ref }) => ref.resourceType === resource('document')));
        },
      }),
    );
    expect(observations).toBe(1);
    expect(result.map(({ ref }) => ref.resourceId)).toEqual([uid(21)]);
    expect(evaluateListAccessPredicate(conjunction, { recordKey: RecordKeySchema.make(uid(20)), teamIds: [] })).toBe(
      false,
    );
  }),
);

it.effect('independent parent targets cannot be replaced by an allowed document grant or the wrong parent', () =>
  Effect.gen(function* parentDoesNotBorrowDocumentRights() {
    const documents = yield* currentDocuments();
    const result = yield* loadCurrentSearchHits(scope, 'legal.agreements.document', { query: 'park' }, state, {
      ...searchAuthorization,
      listAccess: recordKeys(uid(20), uid(21)),
    }).pipe(
      Effect.provideService(AccessDecisionGate, gateAnswer('ALLOWED', recordKeys(uid(11)))),
      Effect.provideService(CoreSearchQueryRuntime, {
        search: () => Effect.succeed(documents.filter(({ ref }) => ref.resourceType === resource('document'))),
      }),
    );
    expect(result.map(({ ref }) => ref.resourceId)).toEqual([uid(21)]);
  }),
);

it.effect('unrelated linked parents do not block a matching independent document or cause extra authority reads', () =>
  Effect.gen(function* independentDocumentOnly() {
    const independent = {
      ...state,
      documents: state.documents.map((document) =>
        document.contractRef === null ? { ...document, title: 'Independent note' } : document,
      ),
    };
    const documents = yield* buildSearchDocuments({
      companies: [{ legalEntityId, state: independent }],
      projectionVersion: '1',
      tenantId,
    });
    const result = yield* loadCurrentSearchHits(
      scope,
      'legal.agreements.document',
      { query: 'independent' },
      independent,
      searchAuthorization,
    ).pipe(
      Effect.provideService(
        AccessDecisionGate,
        gateWithList(() => Effect.die('No matching linked document needs parent authority')),
      ),
      Effect.provideService(CoreSearchQueryRuntime, {
        search: () => Effect.succeed(documents.filter(({ ref }) => ref.resourceType === resource('document'))),
      }),
    );
    expect(result.map(({ ref }) => ref.resourceId)).toEqual([uid(22)]);
  }),
);

for (const outcome of ['allow', '', null]) {
  it.effect(`malformed independent parent outcome ${JSON.stringify(outcome)} is unavailable, never allowed`, () =>
    Effect.gen(function* malformedParentAnswer() {
      const gate = gateWithList((input) =>
        gateAnswer()
          .list(input)
          .pipe(
            Effect.map((answer) => ({
              ...answer,
              decision: new Proxy(answer.decision, { get: () => outcome }),
            })),
          ),
      );
      const error = yield* loadParentContractPredicate(scope, contractsRead).pipe(
        Effect.provideService(AccessDecisionGate, gate),
        Effect.flip,
      );
      expect(Schema.is(SearchProjectionUnavailable)(error)).toBe(true);
    }),
  );
}

it.effect(
  'the genuine Core index receives parent and document restrictions before matching and exposes no denied candidates',
  () =>
    Effect.gen(function* realIndexAuthorization() {
      const documents = yield* currentDocuments();
      const store = makeInMemoryCoreSearchProjectionStore();
      const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
      const worker = attestOutboxWorkerHandlerContext({
        attemptNumber: 1,
        claimId: 'legal-search-proof',
        compositionRevision: 'a'.repeat(64),
        consumerModuleKey: 'legal.agreements',
        deliveryId: 'legal-search-proof',
        domainEventId: 'legal-search-proof',
        messageId: 'legal-search-proof',
        producerModuleKey: 'legal.agreements',
        tenantId,
        tenantSequenceNo: 1n,
        topic: 'legal.agreements.search-changed.v1',
        workerKey: 'legal.agreements.project-search',
      });
      yield* store.replace(
        {
          documents: documents.filter(({ ref }) => ref.resourceType === resource('document')),
          moduleId: 'legal.agreements',
          rebuildVersion: '1',
          resourceType: resource('document'),
          tenantId,
        },
        worker,
      );
      const result = yield* loadCurrentSearchHits(scope, 'legal.agreements.document', { query: 'park' }, state, {
        ...searchAuthorization,
        listAccess: recordKeys(uid(20), uid(21)),
      }).pipe(
        Effect.provideService(ContextAccess, retiredAccess),
        Effect.provideService(AccessDecisionGate, gateAnswer('ALLOWED', recordKeys(uid(11)))),
        Effect.provideService(CoreSearchQueryRuntime, {
          search: (input, requester, authorization) =>
            runtime.search(input, requester, authorization).pipe(Effect.tap(observeAuthorizedCandidates)),
        }),
      );
      expect(result.map(({ ref }) => ref.resourceId)).toEqual([uid(21)]);
    }),
);

it.effect('rejects duplicate or malformed index evidence instead of fabricating an empty success', () =>
  Effect.gen(function* malformedIndex() {
    const documents = yield* currentDocuments();
    const first = yield* Schema.decodeUnknownEffect(CoreSearchProjectionHitSchema)(documents[0]);
    const malformedHit = new Proxy(first, { get: () => null });
    for (const hits of [[first, first], [malformedHit]]) {
      const error = yield* loadCurrentSearchHits(
        scope,
        'legal.agreements.contract',
        { query: 'park' },
        state,
        searchAuthorization,
      ).pipe(
        Effect.provideService(AccessDecisionGate, gateAnswer()),
        Effect.provideService(CoreSearchQueryRuntime, { search: () => Effect.succeed(hits) }),
        Effect.flip,
      );
      expect(Schema.is(SearchProjectionUnavailable)(error)).toBe(true);
    }
  }),
);

interface RegisteredCase {
  readonly kind: 'contract' | 'document';
  readonly missingPredicate?: boolean;
  readonly outcome?: 'ALLOWED' | 'DENIED' | 'UNAVAILABLE';
  readonly parentOutcome?: 'ALLOWED' | 'DENIED' | 'UNAVAILABLE';
  readonly predicate?: ListAccessPredicate;
}
const registeredSearch = (scenario: RegisteredCase) =>
  Effect.scoped(
    Effect.gen(function* registeredScenario() {
      const gate = makeTestBoundAccessGate({
        defaultAnswer: { outcome: scenario.outcome ?? 'ALLOWED', predicate: scenario.predicate ?? allRecords },
      });
      const bound =
        scenario.missingPredicate === true
          ? {
              ...gate.bound,
              list: (input: Parameters<typeof gate.bound.list>[0]) =>
                gate.bound.list(input).pipe(Effect.map(({ decision }) => ({ decision }))),
            }
          : gate.bound;
      let ownerObservations = 0;
      let indexObservations = 0;
      const harness = yield* makeReadTestHarness({
        accessDecision: bound,
        executeOwnerQuery: () => {
          ownerObservations += 1;
          return Effect.succeed([{ legalEntityId, revision: 1, snapshot: state, tenantId }]);
        },
        operationTime: at,
        ownerAuthorizationDecision: 'allowed',
        ownerRegistration: legalAgreementsRegistration,
        scope,
      });
      const access = Context.get(yield* Layer.build(harness.layer), ContextAccess);
      Object.assign(access, { modules: retiredAccess.modules, resources: retiredAccess.resources });
      const documents = yield* currentDocuments();
      const invocation = {
        input: { query: 'park' },
        principal: scope,
        transport: { correlationId: scope.correlationId },
      };
      const run =
        scenario.kind === 'contract'
          ? harness.runtime.runRead({ ...invocation, registration: contractsRead }).pipe(Effect.asVoid)
          : harness.runtime.runRead({ ...invocation, registration: documentsRead }).pipe(Effect.asVoid);
      const result = yield* Effect.exit(
        run.pipe(
          Effect.provideService(ContextAccess, retiredAccess),
          Effect.provideService(
            AccessDecisionGate,
            gateWithList((input) => {
              expect(harness.snapshot().statements).toContain('COMMIT');
              expect(input.carrier.accessDeclaration).toBe(contractsRead.descriptor.accessDeclaration);
              expect(input.scope).toBe(gate.accessDecision.askedLists[0]?.scope);
              return gateAnswer(scenario.parentOutcome ?? 'ALLOWED').list(input);
            }),
          ),
          Effect.provideService(CoreSearchQueryRuntime, {
            search: (_input, requester, authorization) => {
              indexObservations += 1;
              expect(requester).toBe(gate.accessDecision.askedLists[0]?.scope);
              expect(harness.snapshot().statements).toContain('COMMIT');
              expect(authorization?.listAccess).toBeDefined();
              return Effect.succeed(documents.filter(({ ref }) => ref.resourceType === resource(scenario.kind)));
            },
          }),
        ),
      );
      return { gate, indexObservations, ownerObservations, result, snapshot: harness.snapshot() };
    }),
  );

it.layer(NodeCrypto.layer)('both original registered Legal search providers', (suite) => {
  for (const kind of ['contract', 'document'] as const) {
    for (const outcome of ['DENIED', 'UNAVAILABLE'] as const) {
      suite.effect(`${kind} ${outcome} has zero owner and index observations`, () =>
        Effect.gen(function* rejectedEntrypoint() {
          const proof = yield* registeredSearch({ kind, outcome });
          expect(Exit.isFailure(proof.result)).toBe(true);
          if (Exit.isFailure(proof.result)) {
            const error = proof.result.cause.reasons.find(Cause.isFailReason)?.error;
            expect(Schema.is(outcome === 'DENIED' ? ReadPermissionDenied : ReadPermissionUnavailable)(error)).toBe(
              true,
            );
          }
          expect(proof.ownerObservations).toBe(0);
          expect(proof.indexObservations).toBe(0);
          expect(proof.snapshot.ownerQueries).toEqual([]);
          expect(proof.gate.accessDecision.askedLists).toHaveLength(1);
        }),
      );
    }
    for (const scenario of [{ missingPredicate: true }, ...unsupported.map((predicate) => ({ predicate }))]) {
      suite.effect(`${kind} refuses incomplete or unsupported admitted row evidence ${JSON.stringify(scenario)}`, () =>
        Effect.gen(function* invalidAdmittedEvidence() {
          const proof = yield* registeredSearch({ ...scenario, kind });
          expect(Exit.isFailure(proof.result)).toBe(true);
          expect(proof.ownerObservations).toBe(0);
          expect(proof.indexObservations).toBe(0);
        }),
      );
    }
    suite.effect(`${kind} preserves original lifecycle, owner commit and separate evidence`, () =>
      Effect.gen(function* registeredPositive() {
        const proof = yield* registeredSearch({ kind });
        expect(Exit.isSuccess(proof.result), Exit.isFailure(proof.result) ? Cause.pretty(proof.result.cause) : '').toBe(
          true,
        );
        expect(proof.ownerObservations).toBe(1);
        expect(proof.indexObservations).toBe(1);
        expect(proof.snapshot.evidenceWrites).toBe(1);
        expect(proof.snapshot.statements.some((statement) => statement.includes('SAVEPOINT'))).toBe(false);
      }),
    );
  }
  suite.effect('unavailable independent parent authority is sanitized after commit without index observation', () =>
    Effect.gen(function* unavailableParent() {
      const proof = yield* registeredSearch({ kind: 'document', parentOutcome: 'UNAVAILABLE' });
      expect(Exit.isFailure(proof.result)).toBe(true);
      if (Exit.isFailure(proof.result)) {
        const error = proof.result.cause.reasons.find(Cause.isFailReason)?.error;
        expect(Schema.is(ReadHandlerUnavailable)(error)).toBe(true);
        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(error);
        expect(encoded).not.toContain('hidden signatory');
        expect(encoded).not.toContain(uid(20));
      }
      expect(proof.ownerObservations).toBe(1);
      expect(proof.indexObservations).toBe(0);
    }),
  );
});
