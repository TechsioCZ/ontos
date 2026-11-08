import { NodeServices } from '@effect/platform-node';
import {
  customerSegmentDefinitions,
  SalesDemoSeedInputSchema,
  SalesDemoCustomerRolesSchema,
} from '@app/shared-contracts/demo/sales-customer-fixtures';
import type { SalesDemoCustomerRoles, SalesDemoSeedInput } from '@app/shared-contracts/demo/sales-customer-fixtures';
import { DateTime, Effect, FileSystem, Path, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';
import { loadSalesDemoCustomerRoles } from '../../scripts/sales-demo-input.mts';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const inputAt = (now: DateTime.Utc): SalesDemoSeedInput =>
  Schema.decodeUnknownSync(SalesDemoSeedInputSchema)({
    actorPrincipalId: id(1),
    customers: Array.from({ length: 40 }, (_, index) => ({
      city: 'Test',
      counterpartyId: id(index + 100),
      domain: 'example.test',
      ico: String(index).padStart(8, '0'),
      mailbox: 'test',
      membershipInvocationId: id(index + 300),
      name: 'Synthetic test customer',
      partyId: id(index + 200),
      phone: '+420123456789',
      postalCode: '10000',
      profileInvocationId: id(index + 400),
      segmentCode: customerSegmentDefinitions[0].businessCode,
      street: 'Test',
    })),
    expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 15 })),
    format: 'sales-demo-customers/1',
    groups: customerSegmentDefinitions.map(({ businessCode }, index) => ({
      businessCode,
      invocationId: id(index + 500),
    })),
    issuedAt: DateTime.formatIso(now),
    legalEntityId: id(2),
    namespace: id(3),
    runId: id(4),
    tenantId: id(5),
  });
const rolesAt = (input: SalesDemoSeedInput, now: DateTime.Utc): SalesDemoCustomerRoles =>
  Schema.decodeUnknownSync(SalesDemoCustomerRolesSchema)({
    customers: input.customers.map(({ counterpartyId, ico, partyId }, index) => ({
      counterpartyId,
      ico,
      partyId,
      rolePeriodId: id(index + 600),
      roleRecordedAt: DateTime.formatIso(now),
    })),
    expiresAt: DateTime.formatIso(input.expiresAt),
    format: 'sales-demo-customer-roles/1',
    legalEntityId: input.legalEntityId,
    observedAt: DateTime.formatIso(now),
    runId: input.runId,
    tenantId: input.tenantId,
  });

it.layer(NodeServices.layer)('explicit sales-demo owner handoff input', (suite) => {
  suite.effect('loads the exact case and refuses missing, malformed or foreign handoffs before any SQL service', () =>
    Effect.gen(function* validatesFiles() {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe('2026-11-07T12:00:00.000Z')));
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'customer-handoff-unit-' });
      const fixturePath = path.join(directory, 'fixture.json');
      const roleHandoffPath = path.join(directory, 'roles.json');
      const now = yield* DateTime.now;
      const input = inputAt(now);
      const roles = rolesAt(input, now);
      expect(Result.isFailure(yield* Effect.result(loadSalesDemoCustomerRoles(fixturePath, roleHandoffPath)))).toBe(
        true,
      );
      yield* fs.writeFileString(
        fixturePath,
        yield* Schema.encodeEffect(Schema.fromJsonString(SalesDemoSeedInputSchema))(input),
      );
      expect(Result.isFailure(yield* Effect.result(loadSalesDemoCustomerRoles(fixturePath, roleHandoffPath)))).toBe(
        true,
      );
      yield* fs.writeFileString(roleHandoffPath, '{');
      expect(Result.isFailure(yield* Effect.result(loadSalesDemoCustomerRoles(fixturePath, roleHandoffPath)))).toBe(
        true,
      );
      for (const candidate of [
        { ...roles, tenantId: SalesDemoSeedInputSchema.fields.tenantId.make(id(999)) },
        { ...roles, legalEntityId: SalesDemoSeedInputSchema.fields.legalEntityId.make(id(999)) },
        { ...roles, runId: SalesDemoSeedInputSchema.fields.runId.make(id(999)) },
      ]) {
        yield* fs.writeFileString(
          roleHandoffPath,
          yield* Schema.encodeEffect(Schema.fromJsonString(SalesDemoCustomerRolesSchema))(candidate),
        );
        expect(Result.isFailure(yield* Effect.result(loadSalesDemoCustomerRoles(fixturePath, roleHandoffPath)))).toBe(
          true,
        );
      }
      yield* fs.writeFileString(
        roleHandoffPath,
        yield* Schema.encodeEffect(Schema.fromJsonString(SalesDemoCustomerRolesSchema))(roles),
      );
      expect(yield* loadSalesDemoCustomerRoles(fixturePath, roleHandoffPath)).toEqual({ input, roles });
      expect(Result.isFailure(yield* Effect.result(loadSalesDemoCustomerRoles('', roleHandoffPath)))).toBe(true);
      expect(Result.isFailure(yield* Effect.result(loadSalesDemoCustomerRoles(fixturePath, fixturePath)))).toBe(true);
    }),
  );
});
