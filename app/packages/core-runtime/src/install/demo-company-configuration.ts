import { and, eq, inArray, or } from 'drizzle-orm';
import { DateTime, Effect } from 'effect';

import {
  IdentityLifecycleConflictError,
  IdentityPersistenceUnavailableError,
  IdentityTargetInvalidError,
} from '../auth/principal-management-errors.ts';
import { legalEntities, tenantModuleStates } from '../db/schema.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import {
  additionalDemoCompanies,
  commercialDemoCompany,
  demoCompanyTenantId,
  rentalDemoCompany,
} from './demo-company-profiles.ts';

const rentalRegistrationNumber = 'DEMO-SIAMPARK-RENTAL';
const commercialRegistrationNumber = 'DEMO-SIAMPARK';
type AdditionalDemoCompany = (typeof additionalDemoCompanies)[number];
const knownCompanyIds: ReadonlySet<string> = new Set([
  commercialDemoCompany.legalEntityId,
  rentalDemoCompany.legalEntityId,
  ...additionalDemoCompanies.map((company) => company.legalEntityId),
]);
const companyFields = {
  legalEntityId: legalEntities.legalEntityId,
  legalName: legalEntities.legalName,
  registrationCountry: legalEntities.registrationCountry,
  registrationNumber: legalEntities.registrationNumber,
  status: legalEntities.status,
  tenantId: legalEntities.tenantId,
};
export interface DemoCompanyRecord {
  readonly legalEntityId: string;
  readonly legalName: string;
  readonly registrationCountry: string;
  readonly registrationNumber: string;
  readonly status: string;
  readonly tenantId: string;
}
export interface DemoCompanyConfigurationPersistence {
  readonly createCompany: (company: AdditionalDemoCompany) => Effect.Effect<void, IdentityPersistenceUnavailableError>;
  readonly createRental: Effect.Effect<void, IdentityPersistenceUnavailableError>;
  readonly ensureModules: Effect.Effect<void, IdentityPersistenceUnavailableError>;
  readonly load: Effect.Effect<readonly DemoCompanyRecord[], IdentityPersistenceUnavailableError>;
  readonly renameCommercial: Effect.Effect<void, IdentityPersistenceUnavailableError>;
}
const persistenceFailure = (cause: unknown) => {
  const failure = new IdentityPersistenceUnavailableError({
    code: 'identity_persistence_unavailable',
    reason: 'Development company configuration could not be persisted',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};
const validCompany = (row: DemoCompanyRecord, legalEntityId: string, registrationNumber: string) =>
  row.tenantId === demoCompanyTenantId &&
  row.legalEntityId === legalEntityId &&
  row.status === 'active' &&
  row.registrationCountry === 'CZ' &&
  row.registrationNumber === registrationNumber;

export const configureDemoCompanies = Effect.fn('DemoCompanyConfiguration.configure')(function* configureDemoCompanies(
  tenantId: string,
  persistence: DemoCompanyConfigurationPersistence,
) {
  if (tenantId !== demoCompanyTenantId) {
    return yield* new IdentityTargetInvalidError({
      code: 'identity_target_invalid',
      reason: 'This configuration belongs only to the fixed synthetic development tenant',
    });
  }
  const rows = yield* persistence.load;
  const commercial = rows.find((row) => row.legalEntityId === commercialDemoCompany.legalEntityId);
  const rental = rows.find((row) => row.legalEntityId === rentalDemoCompany.legalEntityId);
  if (
    commercial === undefined ||
    !validCompany(commercial, commercialDemoCompany.legalEntityId, commercialRegistrationNumber) ||
    !['Siampark DEMO s.r.o.', commercialDemoCompany.legalName].includes(commercial.legalName) ||
    rows.some((row) => !knownCompanyIds.has(row.legalEntityId)) ||
    additionalDemoCompanies.some((company) => {
      const row = rows.find((candidate) => candidate.legalEntityId === company.legalEntityId);
      return (
        row !== undefined &&
        (!validCompany(row, company.legalEntityId, company.registrationNumber) || row.legalName !== company.legalName)
      );
    }) ||
    (rental !== undefined &&
      (!validCompany(rental, rentalDemoCompany.legalEntityId, rentalRegistrationNumber) ||
        rental.legalName !== rentalDemoCompany.legalName))
  ) {
    return yield* new IdentityLifecycleConflictError({
      code: 'identity_lifecycle_conflict',
      reason: 'The fixed development companies conflict with existing company identity',
    });
  }
  if (commercial.legalName !== commercialDemoCompany.legalName) {
    yield* persistence.renameCommercial;
  }
  if (rental === undefined) {
    yield* persistence.createRental;
  }
  for (const company of additionalDemoCompanies) {
    if (!rows.some((row) => row.legalEntityId === company.legalEntityId)) {
      yield* persistence.createCompany(company);
    }
  }
  yield* persistence.ensureModules;
  return {
    companies: [
      commercialDemoCompany,
      rentalDemoCompany,
      ...additionalDemoCompanies.map(({ legalEntityId, legalName }) => ({ legalEntityId, legalName })),
    ],
    previousCompanyCount: rows.length,
  };
});

const persistenceFromTransaction = (
  transaction: Pick<ScopedTransactionExecutor, 'insert' | 'select' | 'update'>,
): DemoCompanyConfigurationPersistence => ({
  createCompany: ({ legalEntityId, legalName, registrationNumber }) =>
    transaction
      .insert(legalEntities)
      .values({
        legalEntityId,
        legalName,
        registrationCountry: 'CZ',
        registrationNumber,
        status: 'active',
        tenantId: demoCompanyTenantId,
      })
      .pipe(Effect.mapError(persistenceFailure), Effect.asVoid),
  createRental: transaction
    .insert(legalEntities)
    .values({
      ...rentalDemoCompany,
      registrationCountry: 'CZ',
      registrationNumber: rentalRegistrationNumber,
      status: 'active',
      tenantId: demoCompanyTenantId,
    })
    .pipe(Effect.mapError(persistenceFailure), Effect.asVoid),
  ensureModules: Effect.forEach(
    ['siampark.property', 'siampark.occupancy', 'siampark.agreements'],
    (moduleKey, index) =>
      transaction
        .insert(tenantModuleStates)
        .values({
          moduleKey,
          state: 'active',
          tenantId: demoCompanyTenantId,
          tenantModuleStateId: `78000000-0000-4000-8000-${String(101 + index).padStart(12, '0')}`,
        })
        .onConflictDoNothing()
        .pipe(Effect.mapError(persistenceFailure)),
    { concurrency: 1 },
  ).pipe(Effect.asVoid),
  load: transaction
    .select(companyFields)
    .from(legalEntities)
    .where(
      or(
        inArray(legalEntities.legalEntityId, [...knownCompanyIds]),
        and(
          eq(legalEntities.tenantId, demoCompanyTenantId),
          eq(legalEntities.registrationCountry, 'CZ'),
          inArray(legalEntities.registrationNumber, [
            commercialRegistrationNumber,
            rentalRegistrationNumber,
            ...additionalDemoCompanies.map((company) => company.registrationNumber),
          ]),
        ),
      ),
    )
    .for('update')
    .pipe(Effect.mapError(persistenceFailure)),
  renameCommercial: DateTime.nowAsDate.pipe(
    Effect.flatMap((now) =>
      transaction
        .update(legalEntities)
        .set({ legalName: commercialDemoCompany.legalName, updatedAt: now })
        .where(
          and(
            eq(legalEntities.tenantId, demoCompanyTenantId),
            eq(legalEntities.legalEntityId, commercialDemoCompany.legalEntityId),
          ),
        )
        .pipe(Effect.mapError(persistenceFailure)),
    ),
    Effect.asVoid,
  ),
});

export const configureDemoCompaniesFromTransaction = (
  transaction: Pick<ScopedTransactionExecutor, 'insert' | 'select' | 'update'>,
  tenantId: string,
) => configureDemoCompanies(tenantId, persistenceFromTransaction(transaction));
