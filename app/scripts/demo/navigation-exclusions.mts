#!/usr/bin/env node
/**
 * LOCAL ONLY: per-company Shell navigation of the sales demo (core.legal_entity_navigation_exclusions).
 * Replaces every exclusion row of the demo tenant, so it is idempotent and safe to re-run after a reset.
 * - Wholesale CRM pages (order imports, pairing, sales overview, AI changes) exist only in Velkoobchod Hanák;
 *   elsewhere CRM is the register of entrusted contacts.
 * - The opportunity/order AI approval page exists only in Obchodní firma, the company with that agent.
 * - In Hanák the CRM owns the client workflow, so the Party Registry customer list leaves its navigation.
 * Run from app/: node scripts/demo/navigation-exclusions.mts
 */
import { NodeServices } from '@effect/platform-node';
import {
  akrosDemoCompany,
  commercialDemoCompany,
  crmDemoCompany,
  demoCompanyTenantId,
  eshopDemoCompany,
  rentalDemoCompany,
} from '@app/core-runtime/demo-company-profiles';
import { and, eq, inArray } from 'drizzle-orm';
import { Config, ConfigProvider, Console, Effect, Layer, Path, Redacted } from 'effect';

import { DatabaseConfig, parseDatabaseConfig } from '../../packages/core-runtime/src/db/config.ts';
import { legalEntities, legalEntityNavigationExclusions } from '../../packages/core-runtime/src/db/schema.ts';
import { AuthDatabase, AuthDatabaseFromDatabaseConfigLive } from '../../apps/shell-super-app/api/auth/db/client.ts';
import { resetChildEnvironment, resetEnvironment, validateResetEnvironment } from '../siampark/reset-configuration.mts';

const companies = [commercialDemoCompany, rentalDemoCompany, crmDemoCompany, eshopDemoCompany, akrosDemoCompany];
const wholesaleCrmPages = [
  'demo.crm.page.imports',
  'demo.crm.page.pairing',
  'demo.crm.page.reports',
  'demo.crm.page.ai',
] as const;
const salesAiApprovalPage = 'demo.sales-pipeline.page.ai';
const partyCustomersPage = 'party.registry.page.customers';

const excludedFor = (legalEntityId: string): readonly string[] => [
  ...(legalEntityId === crmDemoCompany.legalEntityId ? [partyCustomersPage] : wholesaleCrmPages),
  ...(legalEntityId === commercialDemoCompany.legalEntityId ? [] : [salesAiApprovalPage]),
];

const program = Effect.gen(function* seedNavigationExclusions() {
  yield* validateResetEnvironment(resetChildEnvironment(yield* resetEnvironment));
  const { executor } = yield* AuthDatabase;
  const present = new Set(
    (yield* executor
      .select({ legalEntityId: legalEntities.legalEntityId })
      .from(legalEntities)
      .where(
        and(
          eq(legalEntities.tenantId, demoCompanyTenantId),
          inArray(
            legalEntities.legalEntityId,
            companies.map(({ legalEntityId }) => legalEntityId),
          ),
        ),
      )).map(({ legalEntityId }) => legalEntityId),
  );
  const rows = companies
    .filter(({ legalEntityId }) => present.has(legalEntityId))
    .flatMap(({ legalEntityId }) =>
      excludedFor(legalEntityId).map((entrypointKey) => ({
        entrypointKey,
        legalEntityId,
        tenantId: demoCompanyTenantId,
      })),
    );
  yield* executor
    .delete(legalEntityNavigationExclusions)
    .where(eq(legalEntityNavigationExclusions.tenantId, demoCompanyTenantId));
  if (rows.length > 0) {
    yield* executor.insert(legalEntityNavigationExclusions).values(rows);
  }
  yield* Console.log(`navigation-exclusions: ${rows.length} rows for ${present.size} demo companies`);
});

const environmentLive = ConfigProvider.layer(
  Effect.gen(function* loadOperatorConfiguration() {
    const path = yield* Path.Path;
    const root = yield* path.fromFileUrl(new URL('../..', import.meta.url));
    const file = yield* ConfigProvider.fromDotEnv({ path: path.join(root, '.env') });
    return ConfigProvider.orElse(ConfigProvider.fromEnv(), file);
  }),
);
const adminDatabaseConfigLive = Layer.effect(
  DatabaseConfig,
  Config.Redacted('DATABASE_ADMIN_URL').pipe(
    Effect.flatMap((url) => parseDatabaseConfig({ DATABASE_URL: Redacted.value(url) })),
  ),
);

await Effect.runPromise(
  program.pipe(
    Effect.scoped,
    Effect.provide(AuthDatabaseFromDatabaseConfigLive.pipe(Layer.provide(adminDatabaseConfigLive))),
    Effect.provide(environmentLive),
    Effect.provide(NodeServices.layer),
  ),
);
