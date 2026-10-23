#!/usr/bin/env node
/** Additive workforce fixtures for the Hanák/AKROS pitch. Never resets an agenda or grants permissions.
 * Usage: node scripts/demo/seed-company-employees.mts <hanak|akros> [--apply]
 * Without --apply, validates existing bindings and reports missing employees without writing.
 */
import { NodeServices } from '@effect/platform-node';
import { WorkforceCommandSchema } from '../../verticals/workforce/shared/actions/apply-command.ts';
import { EmployeeSchema } from '../../verticals/workforce/shared/apis/records.ts';
import { Config, Console, Effect, Exit, FileSystem, Layer, Redacted, Schema } from 'effect';
import { Argument, Command, Flag } from 'effect/unstable/cli';
import { FetchHttpClient } from 'effect/unstable/http';

import { akrosDemoLegalEntityId, crmDemoLegalEntityId, demoId, demoTenantId } from './fixture-ids.mts';
import { connectSeedClient, DemoSeedError, validateSeedTarget } from './seed-client.mts';
import type { SeedClient } from './seed-client.mts';
import { seedCheckpointDirectory, seedWriteCheckpoint } from './seed-checkpoint.mts';

const companies = {
  akros: {
    email: 'eshop@akros.demo',
    employees: [
      {
        department: 'E-shop',
        email: 'eshop@akros.demo',
        fullName: 'Správce e-shopu AKROS',
        key: 'akros-eshop',
        role: 'SUPPORT',
      },
      {
        department: 'Sklad a expedice',
        email: 'expedice@akros.demo',
        fullName: 'Expedice AKROS',
        key: 'akros-expedice',
        role: 'WAREHOUSE',
      },
    ],
    legalEntityId: akrosDemoLegalEntityId,
  },
  hanak: {
    email: 'spravce@hanak.demo',
    employees: [
      {
        department: 'Správa firmy',
        email: 'spravce@hanak.demo',
        fullName: 'Karel Hanák',
        key: 'hanak-spravce',
        role: 'SUPPORT',
      },
      {
        department: 'Obchod',
        email: 'vedouci@hanak.demo',
        fullName: 'Lucie Dvořáková',
        key: 'hanak-vedouci',
        role: 'SALES_HEAD',
      },
      {
        department: 'Obchod',
        email: 'obchodnik.a@hanak.demo',
        fullName: 'Jan Novák',
        key: 'hanak-obchodnik-a',
        role: 'SALES_REP',
      },
      {
        department: 'Obchod',
        email: 'obchodnik.b@hanak.demo',
        fullName: 'Petra Svobodová',
        key: 'hanak-obchodnik-b',
        role: 'SALES_REP',
      },
    ],
    legalEntityId: crmDemoLegalEntityId,
  },
} as const;
const WorkforceRecords = Schema.Struct({ items: Schema.Array(Schema.toEncoded(EmployeeSchema)), revision: Schema.Int });
const commandSchema = Schema.toEncoded(WorkforceCommandSchema);

/** Workforce departments and job roles are organizational labels only. Core accounts/rights are never changed. */
export const seedCompanyEmployees = (client: SeedClient, companyKey: keyof typeof companies, apply: boolean) =>
  Effect.gen(function* seedEmployees() {
    const company = companies[companyKey];
    let created = 0;
    for (const employee of company.employees) {
      const records = yield* client.read('workforce', WorkforceRecords);
      const principalRef = { principalId: demoId('core.principal', employee.key), tenantId: demoTenantId };
      const id = demoId('workforce.employee', employee.key);
      const matches = records.items.filter((item) => item.id === id || item.email === employee.email);
      if (matches.length > 1) {
        return yield* new DemoSeedError({ reason: `Duplicate employee binding: ${employee.email}` });
      }
      const [existing] = matches;
      if (existing !== undefined) {
        if (
          existing.email !== employee.email ||
          existing.principalRef?.principalId !== principalRef.principalId ||
          existing.principalRef.tenantId !== demoTenantId
        ) {
          return yield* new DemoSeedError({
            reason: `Existing employee has a different account binding: ${employee.email}; no overwrite performed`,
          });
        }
        yield* Console.log(`Already linked: ${employee.email}`);
      } else if (apply) {
        const { key: _key, ...fields } = employee;
        yield* client.apply(
          'workforce',
          commandSchema,
          {
            _tag: 'CreateEmployee',
            ...fields,
            active: true,
            id,
            principalRef,
          },
          records.revision,
        );
        created += 1;
        yield* Console.log(`Linked: ${employee.email} → ${employee.fullName}`);
      } else {
        yield* Console.log(`Missing: ${employee.email} → ${employee.fullName} (${employee.department})`);
      }
    }
    return { apply, company: companyKey, created, legalEntityId: company.legalEntityId };
  });

if (import.meta.main) {
  const command = Command.make(
    'seed-company-employees',
    {
      apply: Flag.Boolean('apply').pipe(Flag.withDefault(false)),
      company: Argument.Literals('company', ['hanak', 'akros']),
    },
    ({ apply, company: companyKey }) =>
      Effect.gen(function* main() {
        const target = {
          legalEntityId: companies[companyKey].legalEntityId,
          shellUrl: yield* Config.String('ONTOS_DEMO_SEED_URL').pipe(Config.withDefault('http://localhost:3020')),
          tenantId: demoTenantId,
        };
        const origin = yield* validateSeedTarget(target);
        const fs = yield* FileSystem.FileSystem;
        const root = yield* Config.String('ONTOS_DEMO_SEED_CHECKPOINT_DIR').pipe(
          Config.withDefault('.scratch/demo-seed'),
        );
        const checkpoint = seedWriteCheckpoint(fs, seedCheckpointDirectory({ ...target, shellUrl: origin }, root));
        const password = yield* Config.Redacted('ONTOS_DEMO_SEED_PASSWORD').pipe(
          Config.withDefault(Redacted.make('password1234')),
        );
        const email = yield* Config.String('ONTOS_DEMO_SEED_EMAIL').pipe(
          Config.withDefault(companies[companyKey].email),
        );
        const client = yield* connectSeedClient(target, email, password, checkpoint);
        yield* Console.log(yield* seedCompanyEmployees(client, companyKey, apply));
      }),
  );
  const program = Command.run(command, { version: '1.0.0' });
  const exit = await Effect.runPromiseExit(
    program.pipe(
      Effect.tapError((failure) => Console.error(`Employee seed stopped (${failure._tag}); no automatic retry.`)),
      Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    ),
  );
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
