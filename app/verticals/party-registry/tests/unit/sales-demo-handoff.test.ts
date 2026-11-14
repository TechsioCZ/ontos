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
import { publishSalesDemoRolesAfterCommit } from '../../scripts/sales-demo-handoff.mts';

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

it.layer(NodeServices.layer)('committed demo role publication', (suite) => {
  suite.effect('publishes actual supplied observations only after successful commit', () =>
    Effect.gen(function* committedPublication() {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe('2026-11-07T12:00:00.000Z')));
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'party-handoff-unit-' });
      const outputPath = path.join(directory, 'roles.json');
      const now = yield* DateTime.now;
      const input = inputAt(now);
      const roles = rolesAt(input, now);
      const phases: string[] = [];
      yield* publishSalesDemoRolesAfterCommit({
        commit: Effect.sync(() => {
          phases.push('committed');
        }),
        input,
        observe: Effect.sync(() => {
          expect(phases).toEqual(['committed']);
          phases.push('observed');
          return roles;
        }),
        outputPath,
      });
      const saved = yield* fs
        .readFileString(outputPath)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(SalesDemoCustomerRolesSchema))));
      expect(saved).toEqual(roles);
      expect(phases).toEqual(['committed', 'observed']);
    }),
  );
  suite.effect('a failed or rolled-back commit cannot observe or emit role evidence', () =>
    Effect.gen(function* failedCommit() {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe('2026-11-07T12:00:00.000Z')));
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'party-handoff-unit-' });
      const outputPath = path.join(directory, 'roles.json');
      const now = yield* DateTime.now;
      const input = inputAt(now);
      let reads = 0;
      const result = yield* Effect.result(
        publishSalesDemoRolesAfterCommit({
          commit: Effect.fail('commit failed'),
          input,
          observe: Effect.sync(() => {
            reads += 1;
            return rolesAt(input, now);
          }),
          outputPath,
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      expect(reads).toBe(0);
      expect(yield* fs.exists(outputPath)).toBe(false);
    }),
  );
  suite.effect('an unavailable or invalid post-commit observation emits no handoff', () =>
    Effect.gen(function* unavailableObservation() {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe('2026-11-07T12:00:00.000Z')));
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'party-handoff-unit-' });
      const now = yield* DateTime.now;
      const input = inputAt(now);
      for (const [index, observe] of [
        Effect.fail('read unavailable'),
        Effect.succeed({ ...rolesAt(input, now), tenantId: SalesDemoSeedInputSchema.fields.tenantId.make(id(999)) }),
      ].entries()) {
        const outputPath = path.join(directory, `roles-${index}.json`);
        expect(
          Result.isFailure(
            yield* Effect.result(publishSalesDemoRolesAfterCommit({ commit: Effect.void, input, observe, outputPath })),
          ),
        ).toBe(true);
        expect(yield* fs.exists(outputPath)).toBe(false);
      }
    }),
  );
});
