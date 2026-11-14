import {
  CoreSearchProjectionInvalid,
  CoreSearchProjectionStore,
  CoreSearchProjectionUnavailable,
  CoreSearchQuerySchema,
  createCoreSearchQueryRuntime,
  makeInMemoryCoreSearchProjectionStore,
} from '@app/core-runtime';
import type { CoreSearchProjectionStoreService } from '@app/core-runtime';
import { DateTime, Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { WorkforceCommandSchema } from '../../shared/actions/apply-command.ts';
import { evolveEmployeeState } from '../../src/services/persistence.service.ts';
import {
  buildWorkforceSearchDocuments,
  publishWorkforceSearch,
} from '../../src/services/workforce-search-projection.ts';
import type { WorkforceState } from '../../shared/apis/records.ts';
import type { WorkforceSearchSnapshot } from '../../src/services/workforce-search-source.ts';
import {
  companyId,
  employeeId,
  otherCompanyId,
  scope,
  snapshot,
  tenantId,
  workerContext,
} from './workforce-search-fixtures.ts';

const queryInput = (query: string, company = companyId, includeArchived = false) =>
  Schema.decodeSync(CoreSearchQuerySchema)({
    includeArchived,
    moduleId: 'demo.workforce',
    query,
    resourceType: 'demo.workforce.employee',
    selectedLegalEntityId: company,
    tenantId,
  });

// Allowlisted projection construction must ignore extra private owner fields.
const sourceFor = (employees: WorkforceState['employees'], version: string): WorkforceSearchSnapshot => ({
  employees: [
    ...employees.map((employee) => ({ ...employee, legalEntityId: companyId, tenantId })),
    ...snapshot.employees.filter((employee) => employee.legalEntityId === otherCompanyId),
  ],
  projectionVersion: version,
  tenantId,
});

const publish = (source: WorkforceSearchSnapshot, store: CoreSearchProjectionStoreService) =>
  publishWorkforceSearch(workerContext(), source).pipe(Effect.provideService(CoreSearchProjectionStore, store));

it.effect(
  'projects real create/update/bulk archive/reactivation transitions; source withdrawal purges personal evidence',
  () =>
    Effect.gen(function* lifecycle() {
      const now = DateTime.makeUnsafe('2026-11-04T10:00:00.000Z');
      const create = yield* Schema.decodeEffect(WorkforceCommandSchema)({
        _tag: 'CreateEmployee',
        active: true,
        department: 'Účetní oddělení',
        email: 'PRIVATE-CONTACT@example.test',
        fullName: 'Jiří Novotný',
        id: employeeId,
        phone: '+420777111222',
        principalRef: { principalId: scope.principalId, tenantId },
        role: 'ACCOUNTANT',
      });
      const created = yield* evolveEmployeeState({ employees: [] }, create, { now });
      const store = makeInMemoryCoreSearchProjectionStore();
      const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
      const search = (query: string, company = companyId, includeArchived = false) =>
        runtime.search(queryInput(query, company, includeArchived), { ...scope, legalEntityId: company });
      yield* publish(sourceFor(created.employees, '1'), store);
      expect((yield* search('jiri accountant oddeleni')).map((hit) => hit.ref.resourceId)).toEqual([employeeId]);
      for (const privateQuery of ['PRIVATE-CONTACT', '777111222', scope.principalId]) {
        expect(yield* search(privateQuery)).toEqual([]);
      }
      const documents = yield* buildWorkforceSearchDocuments(sourceFor(created.employees, '1'));
      expect(JSON.stringify(documents)).not.toMatch(/PRIVATE-CONTACT|777111222|principalRef|createdAt|updatedAt/u);
      expect(documents.every((document) => document.metadata.length === 0 && document.aliases?.length === 0)).toBe(
        true,
      );

      const update = yield* Schema.decodeEffect(WorkforceCommandSchema)({
        _tag: 'UpdateEmployee',
        id: employeeId,
        patch: { department: 'Zákaznická podpora', fullName: 'Petr Černý', role: 'SUPPORT' },
      });
      const updated = yield* evolveEmployeeState(created.state, update, { now });
      yield* publish(sourceFor(updated.employees, '2'), store);
      expect(yield* search('jiri')).toEqual([]);
      expect(yield* search('accountant')).toEqual([]);
      expect((yield* search('cerny podpora')).map((hit) => hit.title)).toEqual(['Petr Černý']);

      const archive = yield* Schema.decodeEffect(WorkforceCommandSchema)({
        _tag: 'BulkUpdateEmployees',
        ids: [employeeId],
        patch: { active: false },
      });
      const archived = yield* evolveEmployeeState(updated.state, archive, { now });
      yield* publish(sourceFor(archived.employees, '3'), store);
      expect(yield* search('cerny', companyId, true)).toEqual([]);
      expect(yield* store.queryCandidates(queryInput('cerny'), scope)).toEqual([]);
      expect((yield* search('jana', otherCompanyId)).length).toBe(1);

      const reactivate = yield* Schema.decodeEffect(WorkforceCommandSchema)({
        _tag: 'UpdateEmployee',
        id: employeeId,
        patch: { active: true },
      });
      const reactivated = yield* evolveEmployeeState(archived.state, reactivate, { now });
      const prior = sourceFor(reactivated.employees, '4');
      yield* publish(prior, store);
      expect((yield* search('cerny')).length).toBe(1);
      const withdrawn = sourceFor([], '5');
      yield* publish(withdrawn, store);
      expect(yield* search('cerny', companyId, true)).toEqual([]);
      expect(yield* store.queryCandidates(queryInput('cerny'), scope)).toEqual([]);
      // Lost acknowledgement/repeated delivery and a delayed older snapshot cannot resurrect withdrawn evidence.
      yield* publish(withdrawn, store);
      yield* publish(prior, store);
      expect(yield* search('cerny', companyId, true)).toEqual([]);
      expect((yield* search('jana', otherCompanyId)).length).toBe(1);
    }),
);

it.effect('a reused generation with different evidence fails atomically and preserves the prior projection', () =>
  Effect.gen(function* conflict() {
    const store = makeInMemoryCoreSearchProjectionStore();
    yield* publish(snapshot, store);
    const failure = yield* publish({ ...snapshot, employees: [] }, store).pipe(Effect.flip);
    expect(Schema.is(CoreSearchProjectionInvalid)(failure)).toBe(true);
    expect((yield* store.queryCandidates(queryInput('jiri'), scope)).length).toBe(1);
  }),
);

it.effect('source tenant/identity/schema failures never begin replacement or manufacture a partial index', () =>
  Effect.gen(function* invalidSource() {
    let replacements = 0;
    const store: CoreSearchProjectionStoreService = {
      apply: () => Effect.die('No incremental write'),
      queryCandidates: () => Effect.die('No query source'),
      replace: () =>
        Effect.sync(() => {
          replacements += 1;
        }),
    };
    const [first] = snapshot.employees;
    expect(first).toBeDefined();
    if (first === undefined) {
      return;
    }
    const invalid: readonly WorkforceSearchSnapshot[] = [
      { ...snapshot, tenantId: otherCompanyId },
      { ...snapshot, employees: [{ ...first, tenantId: otherCompanyId }] },
      { ...snapshot, employees: [...snapshot.employees, { ...first, legalEntityId: otherCompanyId }] },
      { ...snapshot, employees: [{ ...first, legalEntityId: 'invalid-company' }] },
      { ...snapshot, projectionVersion: '0' },
      { ...snapshot, employees: [{ ...first, fullName: '' }] },
    ];
    for (const source of invalid) {
      expect(Exit.isFailure(yield* Effect.exit(publish(source, store)))).toBe(true);
    }
    expect(replacements).toBe(0);
  }),
);

it.effect('a failed projection transaction stays retryable; retry publishes the same complete replacement', () =>
  Effect.gen(function* failedPublication() {
    const store = makeInMemoryCoreSearchProjectionStore();
    yield* publish(snapshot, store);
    const unavailable: CoreSearchProjectionStoreService = {
      ...store,
      replace: () =>
        Effect.fail(
          new CoreSearchProjectionUnavailable({
            code: 'core_search_projection_unavailable',
            reason: 'Test replacement transaction rolled back',
          }),
        ),
    };
    const withdrawal = { ...snapshot, employees: [], projectionVersion: '2' };
    const failure = yield* publish(withdrawal, unavailable).pipe(Effect.flip);
    expect(Schema.is(CoreSearchProjectionUnavailable)(failure)).toBe(true);
    expect((yield* store.queryCandidates(queryInput('jiri'), scope)).length).toBe(1);
    yield* publish(withdrawal, store);
    expect(yield* store.queryCandidates(queryInput('jiri'), scope)).toEqual([]);
  }),
);

it.effect('initial population accepts a verified rebuild worker but rejects a forged operator/worker context', () =>
  Effect.gen(function* initialPopulation() {
    const store = makeInMemoryCoreSearchProjectionStore();
    const forged = { ...workerContext('rebuild') };
    const failure = yield* publishWorkforceSearch(forged, snapshot).pipe(
      Effect.provideService(CoreSearchProjectionStore, store),
      Effect.flip,
    );
    expect(Schema.is(CoreSearchProjectionInvalid)(failure)).toBe(true);
    expect(yield* store.queryCandidates(queryInput('jiri'), scope)).toEqual([]);
    yield* publishWorkforceSearch(workerContext('rebuild'), snapshot).pipe(
      Effect.provideService(CoreSearchProjectionStore, store),
    );
    expect((yield* store.queryCandidates(queryInput('jiri'), scope)).length).toBe(1);
  }),
);
