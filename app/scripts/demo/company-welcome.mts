#!/usr/bin/env node
/**
 * LOCAL ONLY: what each sales-demo company says about itself on Home (core.legal_entities.welcome).
 * Sets the text of every listed company of the demo tenant and clears it for the others, so it is idempotent and
 * safe to re-run after a reset.
 * Run from app/: node scripts/demo/company-welcome.mts
 */
import { NodeServices } from '@effect/platform-node';
import {
  commercialDemoCompany,
  crmDemoCompany,
  demoCompanyTenantId,
  eshopDemoCompany,
  rentalDemoCompany,
} from '@app/core-runtime/demo-company-profiles';
import { and, eq, notInArray } from 'drizzle-orm';
import { Config, ConfigProvider, Console, Effect, Layer, Path, Redacted } from 'effect';

import { DatabaseConfig, parseDatabaseConfig } from '../../packages/core-runtime/src/db/config.ts';
import { legalEntities } from '../../packages/core-runtime/src/db/schema.ts';
import { AuthDatabase, AuthDatabaseFromDatabaseConfigLive } from '../../apps/shell-super-app/api/auth/db/client.ts';
import { resetChildEnvironment, resetEnvironment, validateResetEnvironment } from '../siampark/reset-configuration.mts';

const welcomes: readonly { readonly legalEntityId: string; readonly welcome: string }[] = [
  {
    legalEntityId: commercialDemoCompany.legalEntityId,
    welcome: 'Velkoobchod s e-shopem: zákazníci, příležitosti, objednávky, sklad a faktury na jednom místě.',
  },
  {
    legalEntityId: rentalDemoCompany.legalEntityId,
    welcome: 'Správa areálu: nemovitosti, nájmy, smlouvy, provoz, energie a finance pod jednou střechou.',
  },
  {
    legalEntityId: crmDemoCompany.legalEntityId,
    welcome: 'Obchodní tým velkoobchodu: klienti, plán oslovení, návštěvy, importy objednávek a přehled prodejů.',
  },
  {
    legalEntityId: eshopDemoCompany.legalEntityId,
    welcome: 'E-shop s kávou, čajem a potřebami pro přípravu: produkty, varianty, objednávky a expedice.',
  },
];

const program = Effect.gen(function* seedCompanyWelcome() {
  yield* validateResetEnvironment(resetChildEnvironment(yield* resetEnvironment));
  const { executor } = yield* AuthDatabase;
  let updated = 0;
  for (const { legalEntityId, welcome } of welcomes) {
    const rows = yield* executor
      .update(legalEntities)
      .set({ welcome })
      .where(and(eq(legalEntities.tenantId, demoCompanyTenantId), eq(legalEntities.legalEntityId, legalEntityId)))
      .returning({ legalEntityId: legalEntities.legalEntityId });
    updated += rows.length;
  }
  yield* executor
    .update(legalEntities)
    .set({ welcome: null })
    .where(
      and(
        eq(legalEntities.tenantId, demoCompanyTenantId),
        notInArray(
          legalEntities.legalEntityId,
          welcomes.map(({ legalEntityId }) => legalEntityId),
        ),
      ),
    );
  yield* Console.log(`company-welcome: ${updated} demo companies describe themselves on Home`);
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
