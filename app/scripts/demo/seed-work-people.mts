#!/usr/bin/env node
/** Local, additive S13 employee-to-login bindings. Requires the running demo and accounts-admin-grants.mts.
 * Only uses governed workforce Reads/Actions; never resets another agenda or company.
 */
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { WorkforceCommandSchema } from '@app/workforce/contracts/apply-command';
import { RecordsResponseSchema } from '@app/workforce/contracts/records';
import { Config, Console, Effect, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { demoId, demoTenantId, rentalDemoLegalEntityId } from './fixture-ids.mts';
import { connectSeedClient } from './seed-client.mts';

const people = [
  ['management', 'Vedení Siampark', 'SALES_HEAD', 'Vedení', '21'],
  ['operations', 'Provoz Siampark', 'SUPPORT', 'Správa areálu', '22'],
  ['finance', 'Účetní Siampark', 'ACCOUNTANT', 'Finance', '23'],
  ['external', 'Externí obchodník', 'SALES_REP', 'Externí spolupráce', '24'],
] as const;

const program = Effect.gen(function* linkWorkforceLogins() {
  const shellUrl = yield* Config.String('ONTOS_SHELL_URL').pipe(Config.withDefault('http://localhost:3020'));
  const password = yield* Config.Redacted('ONTOS_DEMO_PASSWORD').pipe(
    Config.withDefault(Redacted.make('password1234')),
  );
  const client = yield* connectSeedClient(
    { legalEntityId: rentalDemoLegalEntityId, shellUrl, tenantId: demoTenantId },
    'management@siampark.demo',
    password,
  );
  for (const [key, name, role, department, suffix] of people) {
    const records = yield* client.read('workforce', RecordsResponseSchema);
    const id = demoId('workforce.employee', `siampark-${key}`);
    const email = `${key}@siampark.demo`;
    const existing = records.items.find((item) => item.id === id || item.email === email);
    if (existing !== undefined) {
      yield* Console.log(`Already linked: ${email}`);
      continue;
    }
    const command = yield* Schema.decodeUnknownEffect(WorkforceCommandSchema)({
      _tag: 'CreateEmployee',
      active: true,
      department,
      email,
      fullName: name,
      id,
      principalRef: { principalId: `72000000-0000-4000-8000-0000000000${suffix}`, tenantId: demoTenantId },
      role,
    });
    yield* client.apply('workforce', WorkforceCommandSchema, command, records.revision);
    yield* Console.log(`Linked: ${email} → ${name}`);
  }
});

NodeRuntime.runMain(
  program.pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer), Effect.provide(NodeServices.layer)),
);
