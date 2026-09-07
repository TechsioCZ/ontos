import {
  makeEffectTestCallback as nativeTestCallback,
  makeEffectTestCallback,
} from '@app/core-runtime/testing/effect-runtime';

import { eq } from 'drizzle-orm';
import { Effect, Exit as NativeExit, Scope as NativeScope, Predicate } from 'effect';
import assert from 'node:assert/strict';
import test, { after as afterNativeDatabase } from 'node:test';
import { Pool } from 'pg';
import { makeLegalEntityContext } from '../../src/auth/legal-entity-context.ts';
import { loadDatabaseConfig } from '../../src/db/config.ts';
import { coreRelations, legalEntities, tenants } from '../../src/db/schema.ts';
import { makeTestDatabaseFromPool } from '../support/database.ts';
import { runEffectTestSync as runNativeSync } from '../support/effect-runtime.ts';

const nativeDatabaseScope = runNativeSync(NativeScope.make());
const databaseEffect = <Value>(operation: () => PromiseLike<Value>) =>
  Effect.promise(() => operation());
afterNativeDatabase(
  NativeScope.close(nativeDatabaseScope, NativeExit.void).pipe(nativeTestCallback),
);

const tenantOne = '11000000-0000-4000-8000-000000000001';
const tenantTwo = '11000000-0000-4000-8000-000000000002';
const activeOne = '21000000-0000-4000-8000-000000000001';
const activeTwo = '21000000-0000-4000-8000-000000000002';
const suspended = '21000000-0000-4000-8000-000000000003';
const foreign = '21000000-0000-4000-8000-000000000004';

const effectTest = <Value, Failure>(name: string, effect: Effect.Effect<Value, Failure>): void => {
  test(name, makeEffectTestCallback(effect));
};

effectTest(
  'lists and validates only active legal entities inside the exact tenant',
  Effect.gen(function* legalEntityContextIntegration() {
    const configuration = yield* loadDatabaseConfig();
    const pool = new Pool({ connectionString: configuration.connectionString });
    const database = yield* makeTestDatabaseFromPool(pool, coreRelations).pipe(
      NativeScope.provide(nativeDatabaseScope),
    );
    const context = makeLegalEntityContext({ executor: database });
    const cleanup = Effect.gen(function* cleanLegalEntityContextFixtures() {
      yield* database.delete(legalEntities).where(eq(legalEntities.tenantId, tenantOne));
      yield* database.delete(legalEntities).where(eq(legalEntities.tenantId, tenantTwo));
      yield* database.delete(tenants).where(eq(tenants.tenantId, tenantOne));
      yield* database.delete(tenants).where(eq(tenants.tenantId, tenantTwo));
    });

    yield* cleanup;
    yield* Effect.gen(function* exerciseLegalEntityContext() {
      yield* database.insert(tenants).values([
        {
          defaultLocale: 'en',
          name: 'Legal context tenant one',
          slug: 'legal-context-tenant-one',
          status: 'active',
          tenantId: tenantOne,
        },
        {
          defaultLocale: 'en',
          name: 'Legal context tenant two',
          slug: 'legal-context-tenant-two',
          status: 'active',
          tenantId: tenantTwo,
        },
      ]);
      yield* database.insert(legalEntities).values([
        {
          legalEntityId: activeOne,
          legalName: 'Zeta entity',
          registrationCountry: 'CZ',
          registrationNumber: 'LEGAL-CONTEXT-1',
          status: 'active',
          tenantId: tenantOne,
        },
        {
          legalEntityId: activeTwo,
          legalName: 'Alpha entity',
          registrationCountry: 'CZ',
          registrationNumber: 'LEGAL-CONTEXT-2',
          status: 'active',
          tenantId: tenantOne,
        },
        {
          legalEntityId: suspended,
          legalName: 'Suspended entity',
          registrationCountry: 'CZ',
          registrationNumber: 'LEGAL-CONTEXT-3',
          status: 'suspended',
          tenantId: tenantOne,
        },
        {
          legalEntityId: foreign,
          legalName: 'Foreign entity',
          registrationCountry: 'CZ',
          registrationNumber: 'LEGAL-CONTEXT-4',
          status: 'active',
          tenantId: tenantTwo,
        },
      ]);

      assert.deepEqual(yield* context.listActiveForTenant(tenantOne), [
        { legalEntityId: activeTwo, legalName: 'Alpha entity' },
        { legalEntityId: activeOne, legalName: 'Zeta entity' },
      ]);
      assert.deepEqual(yield* context.validateSelection(tenantOne, activeOne), {
        legalEntityId: activeOne,
        legalName: 'Zeta entity',
      });
      const inactiveError = yield* Effect.flip(context.validateSelection(tenantOne, suspended));
      assert.ok(Predicate.isTagged(inactiveError, 'LegalEntityContextInactiveError'));
      const missingError = yield* Effect.flip(context.validateSelection(tenantOne, foreign));
      assert.ok(Predicate.isTagged(missingError, 'LegalEntityContextMissingError'));
    }).pipe(
      Effect.ensuring(cleanup.pipe(Effect.orDie)),
      Effect.ensuring(databaseEffect(pool.end.bind(pool)).pipe(Effect.orDie)),
    );
  }),
);
