import { expect, it } from 'effect-rstest';

import { eq } from 'drizzle-orm';
import { Effect, Predicate } from 'effect';
import { makeLegalEntityContext } from '../../src/auth/legal-entity-context.ts';
import { loadDatabaseConfig } from '../../src/db/config.ts';
import { legalEntities, tenants } from '../../src/db/schema.ts';
import { makeCoreDatabase } from '../../src/db/client.ts';

const tenantOne = '11000000-0000-4000-8000-000000000001';
const tenantTwo = '11000000-0000-4000-8000-000000000002';
const activeOne = '21000000-0000-4000-8000-000000000001';
const activeTwo = '21000000-0000-4000-8000-000000000002';
const suspended = '21000000-0000-4000-8000-000000000003';
const foreign = '21000000-0000-4000-8000-000000000004';

it.live('lists and validates only active legal entities inside the exact tenant', () =>
  Effect.gen(function* legalEntityContextIntegration() {
    const configuration = yield* loadDatabaseConfig();
    const { executor: database } = yield* makeCoreDatabase(configuration);
    const context = makeLegalEntityContext({ executor: database });
    const cleanup = Effect.gen(function* cleanLegalEntityContextFixtures() {
      yield* database.delete(legalEntities).where(eq(legalEntities.tenantId, tenantOne));
      yield* database.delete(legalEntities).where(eq(legalEntities.tenantId, tenantTwo));
      yield* database.delete(tenants).where(eq(tenants.tenantId, tenantOne));
      yield* database.delete(tenants).where(eq(tenants.tenantId, tenantTwo));
    });

    yield* Effect.acquireRelease(cleanup, () => cleanup.pipe(Effect.orDie));

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

    expect(yield* context.listActiveForTenant(tenantOne)).toEqual([
      { legalEntityId: activeTwo, legalName: 'Alpha entity' },
      { legalEntityId: activeOne, legalName: 'Zeta entity' },
    ]);
    expect(yield* context.validateSelection(tenantOne, activeOne)).toEqual({
      legalEntityId: activeOne,
      legalName: 'Zeta entity',
    });
    const inactiveError = yield* Effect.flip(context.validateSelection(tenantOne, suspended));
    expect(Predicate.isTagged(inactiveError, 'LegalEntityContextInactiveError')).toBe(true);
    const missingError = yield* Effect.flip(context.validateSelection(tenantOne, foreign));
    expect(Predicate.isTagged(missingError, 'LegalEntityContextMissingError')).toBe(true);
  }),
);
