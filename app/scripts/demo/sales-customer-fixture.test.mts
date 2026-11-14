import { NodeCrypto, NodeServices } from '@effect/platform-node';
import {
  SalesDemoSeedInputSchema,
  SalesDemoCustomerRolesSchema,
  validateSalesDemoCustomerRoles,
} from '@app/shared-contracts/demo/sales-customer-fixtures';
import type { SalesDemoCustomerRoles } from '@app/shared-contracts/demo/sales-customer-fixtures';
import { DateTime, Effect, FileSystem, Layer, Option, Path, Ref, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeSalesDemoCustomerFixture, withSalesDemoCustomerHandoff } from './sales-customer-fixture.mts';

const now = DateTime.makeUnsafe('2026-11-07T12:00:00.000Z');
const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const fixture = makeSalesDemoCustomerFixture(id(1), now);
const rolesFor = (input: Effect.Success<typeof fixture>): SalesDemoCustomerRoles =>
  Schema.decodeUnknownSync(SalesDemoCustomerRolesSchema)({
    customers: input.customers.map(({ counterpartyId, ico, partyId }, index) => ({
      counterpartyId,
      ico,
      partyId,
      rolePeriodId: id(index + 100),
      roleRecordedAt: '2024-03-04T08:00:00.000Z',
    })),
    expiresAt: DateTime.formatIso(input.expiresAt),
    format: 'sales-demo-customer-roles/1',
    legalEntityId: input.legalEntityId,
    observedAt: DateTime.formatIso(now),
    runId: input.runId,
    tenantId: input.tenantId,
  });

it.effect('accepts the exact complete committed owner observation', () =>
  Effect.gen(function* completeRoles() {
    const input = yield* fixture;
    expect(yield* validateSalesDemoCustomerRoles(input, rolesFor(input), now)).toEqual(rolesFor(input));
  }),
);

for (const field of ['tenantId', 'legalEntityId', 'runId'] as const) {
  it.effect(`refuses foreign ${field} without treating it as fixture authority`, () =>
    Effect.gen(function* foreignScope() {
      const input = yield* fixture;
      expect(
        Result.isFailure(
          yield* Effect.result(
            Schema.decodeUnknownEffect(Schema.toType(SalesDemoCustomerRolesSchema))({
              ...rolesFor(input),
              [field]: id(9),
            }).pipe(Effect.flatMap((roles) => validateSalesDemoCustomerRoles(input, roles, now))),
          ),
        ),
      ).toBe(true);
    }),
  );
}

it.effect('refuses missing, malformed, duplicate, foreign-customer and stale handoffs', () =>
  Effect.gen(function* invalidObservations() {
    const input = yield* fixture;
    const roles = rolesFor(input);
    const [first] = roles.customers;
    if (first === undefined) {
      return yield* Effect.die('The complete fixture must have a first customer');
    }
    for (const candidate of [
      undefined,
      '{',
      {},
      { ...roles, customers: roles.customers.slice(1) },
      { ...roles, customers: roles.customers.map(() => first) },
      {
        ...roles,
        customers: roles.customers.map((row, index) => (index === 0 ? { ...row, counterpartyId: id(999) } : row)),
      },
      { ...roles, customers: roles.customers.map((row, index) => (index === 0 ? { ...row, partyId: id(999) } : row)) },
      { ...roles, customers: roles.customers.map((row, index) => (index === 0 ? { ...row, ico: '99999999' } : row)) },
      { ...roles, observedAt: DateTime.makeUnsafe('2026-11-07T11:59:59.000Z') },
      { ...roles, observedAt: DateTime.makeUnsafe('2026-11-07T12:00:01.000Z') },
      { ...roles, expiresAt: DateTime.makeUnsafe('2026-11-07T11:00:00.000Z') },
      {
        ...roles,
        customers: roles.customers.map((row, index) => (index === 0 ? { ...row, rolePeriodId: 'invalid' } : row)),
      },
      { ...roles, customers: roles.customers.map((row) => ({ ...row, rolePeriodId: first.rolePeriodId })) },
    ]) {
      expect(
        Result.isFailure(
          yield* Effect.result(
            Schema.decodeUnknownEffect(Schema.toType(SalesDemoCustomerRolesSchema))(candidate).pipe(
              Effect.flatMap((decoded) => validateSalesDemoCustomerRoles(input, decoded, now)),
            ),
          ),
        ),
      ).toBe(true);
    }
    expect(
      Result.isFailure(
        yield* Effect.result(validateSalesDemoCustomerRoles(input, roles, DateTime.add(now, { minutes: 16 }))),
      ),
    ).toBe(true);
    return yield* Effect.void;
  }),
);

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))('owned customer handoff lifecycle', (suite) => {
  suite.effect('removes only its own directory after success', () =>
    Effect.gen(function* successfulCleanup() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* withSalesDemoCustomerHandoff(({ fixture: file, roleHandoff }) =>
        Effect.gen(function* inspectFiles() {
          expect(yield* fs.exists(roleHandoff)).toBe(false);
          const input = yield* fs
            .readFileString(file)
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(SalesDemoSeedInputSchema))));
          expect(input.customers).toHaveLength(40);
          return path.dirname(file);
        }),
      );
      expect(yield* fs.exists(directory)).toBe(false);
    }),
  );
  suite.effect('removes its directory when the next operation fails', () =>
    Effect.gen(function* failureCleanup() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const captured = yield* Ref.make(Option.none<string>());
      const result = yield* Effect.result(
        withSalesDemoCustomerHandoff(({ fixture: file }) =>
          Ref.set(captured, Option.some(path.dirname(file))).pipe(Effect.andThen(Effect.fail('owned failure'))),
        ),
      );
      expect(Result.isFailure(result)).toBe(true);
      const directory = yield* Ref.get(captured);
      expect(Option.isSome(directory)).toBe(true);
      if (Option.isSome(directory)) {
        expect(yield* fs.exists(directory.value)).toBe(false);
      }
      return yield* Effect.void;
    }),
  );
});
