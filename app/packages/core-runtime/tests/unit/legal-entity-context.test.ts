import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
import { Effect, flow, Predicate } from 'effect';
import { ConnectionError, SqlError } from 'effect/unstable/sql/SqlError';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { LegalEntityContextRecord } from '../../src/auth/legal-entity-context.ts';
import {
  classifyActiveLegalEntities,
  classifySelectedLegalEntity,
  makeLegalEntityContext,
} from '../../src/auth/legal-entity-context.ts';
import { makeTestDatabase } from '../support/database.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const effectTest = <Value, Failure>(name: string, effect: Effect.Effect<Value, Failure>): void => {
  test(
    name,
    flow(() => Effect.asVoid(effect), runEffectTestPromise),
  );
};
const activeRecord: LegalEntityContextRecord = {
  legalEntityId: '20000000-0000-4000-8000-000000000001',
  legalName: 'Zeta s.r.o.',
  status: 'active',
  tenantId,
};

effectTest(
  'lists zero, one, and many active legal entities in deterministic safe order',
  Effect.gen(function* listsActiveLegalEntities() {
    assert.deepEqual(yield* classifyActiveLegalEntities([], tenantId), []);
    assert.deepEqual(yield* classifyActiveLegalEntities([activeRecord], tenantId), [
      { legalEntityId: activeRecord.legalEntityId, legalName: 'Zeta s.r.o.' },
    ]);
    assert.deepEqual(
      yield* classifyActiveLegalEntities(
        [
          activeRecord,
          {
            ...activeRecord,
            legalEntityId: '20000000-0000-4000-8000-000000000003',
            legalName: 'Alpha s.r.o.',
          },
          {
            ...activeRecord,
            legalEntityId: '20000000-0000-4000-8000-000000000002',
            legalName: 'Alpha s.r.o.',
          },
          {
            ...activeRecord,
            legalEntityId: '20000000-0000-4000-8000-000000000004',
            legalName: 'Suspended s.r.o.',
            status: 'suspended',
          },
          {
            ...activeRecord,
            legalEntityId: '20000000-0000-4000-8000-000000000005',
            legalName: 'Archived s.r.o.',
            status: 'archived',
          },
        ],
        tenantId,
      ),
      [
        {
          legalEntityId: '20000000-0000-4000-8000-000000000002',
          legalName: 'Alpha s.r.o.',
        },
        {
          legalEntityId: '20000000-0000-4000-8000-000000000003',
          legalName: 'Alpha s.r.o.',
        },
        { legalEntityId: activeRecord.legalEntityId, legalName: 'Zeta s.r.o.' },
      ],
    );
  }),
);

effectTest(
  'validates exactly one active selection and rejects missing or inactive selections',
  Effect.gen(function* validatesLegalEntitySelection() {
    assert.deepEqual(
      yield* classifySelectedLegalEntity([activeRecord], tenantId, activeRecord.legalEntityId),
      { legalEntityId: activeRecord.legalEntityId, legalName: activeRecord.legalName },
    );
    assert.ok(
      Predicate.isTagged(
        yield* Effect.flip(
          classifySelectedLegalEntity(
            [activeRecord],
            tenantId,
            '20000000-0000-4000-8000-000000000099',
          ),
        ),
        'LegalEntityContextMissingError',
      ),
    );
    assert.ok(
      Predicate.isTagged(
        yield* Effect.flip(
          classifySelectedLegalEntity(
            [{ ...activeRecord, status: 'suspended' }],
            tenantId,
            activeRecord.legalEntityId,
          ),
        ),
        'LegalEntityContextInactiveError',
      ),
    );
  }),
);

effectTest(
  'rejects cross-tenant, malformed, and duplicate records',
  Effect.gen(function* rejectsInvalidLegalEntityRecords() {
    assert.ok(
      Predicate.isTagged(
        yield* Effect.flip(
          classifyActiveLegalEntities(
            [{ ...activeRecord, tenantId: '10000000-0000-4000-8000-000000000002' }],
            tenantId,
          ),
        ),
        'LegalEntityContextInvalidError',
      ),
    );
    assert.ok(
      Predicate.isTagged(
        yield* Effect.flip(
          classifyActiveLegalEntities([{ ...activeRecord, legalName: '' }], tenantId),
        ),
        'LegalEntityContextInvalidError',
      ),
    );
    assert.ok(
      Predicate.isTagged(
        yield* Effect.flip(
          classifyActiveLegalEntities([activeRecord, { ...activeRecord }], tenantId),
        ),
        'LegalEntityContextAmbiguousError',
      ),
    );
  }),
);

effectTest(
  'types database failures as sanitized legal-entity context unavailability',
  Effect.gen(function* sanitizesLegalEntityDatabaseFailure() {
    const context = makeLegalEntityContext({
      executor: makeTestDatabase(() =>
        Effect.fail(
          new SqlError({
            reason: new ConnectionError({ cause: new Error('secret database diagnostic') }),
          }),
        ),
      ),
    });
    const error = yield* Effect.flip(context.listActiveForTenant(tenantId));
    assert.ok(Predicate.isTagged(error, 'LegalEntityContextUnavailableError'));
    assert.doesNotMatch(error.reason, /secret database diagnostic/u);
  }),
);
