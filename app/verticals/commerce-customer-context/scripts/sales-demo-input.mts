import {
  SalesDemoFixtureInvalid,
  decodeSalesDemoSeedInput,
  decodeSalesDemoCustomerRoles,
  validateSalesDemoCustomerRoles,
  validateSalesDemoSeedInput,
} from '@app/shared-contracts/demo/sales-customer-fixtures';
import { DateTime, Effect, FileSystem, Path, Schema } from 'effect';

/** Explicit operator-owned files only. No ambient path, default evidence or foreign owner read. */
export const loadSalesDemoCustomerRoles = Effect.fn('CustomerContextSalesDemo.loadExplicitRoles')(
  function* loadExplicitRoles(fixturePath: string, roleHandoffPath: string) {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    if (
      !path.isAbsolute(fixturePath) ||
      !path.isAbsolute(roleHandoffPath) ||
      path.dirname(fixturePath) !== path.dirname(roleHandoffPath) ||
      fixturePath === roleHandoffPath
    ) {
      return yield* new SalesDemoFixtureInvalid({
        reason: 'Explicit sibling fixture and role handoff paths are required',
      });
    }
    const read = (file: string) =>
      fs.readFileString(file).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))),
        Effect.mapError(
          () =>
            new SalesDemoFixtureInvalid({
              reason: 'The explicit customer fixture or role handoff is missing or malformed',
            }),
        ),
      );
    const input = yield* validateSalesDemoSeedInput(
      yield* decodeSalesDemoSeedInput(yield* read(fixturePath)),
      yield* DateTime.now,
    );
    const roles = yield* validateSalesDemoCustomerRoles(
      input,
      yield* decodeSalesDemoCustomerRoles(yield* read(roleHandoffPath)),
      yield* DateTime.now,
    );
    return { input, roles };
  },
);
