import {
  SalesDemoCustomerRolesSchema,
  SalesDemoFixtureInvalid,
  validateSalesDemoCustomerRoles,
} from '@app/shared-contracts/demo/sales-customer-fixtures';
import type { SalesDemoCustomerRoles, SalesDemoSeedInput } from '@app/shared-contracts/demo/sales-customer-fixtures';
import { DateTime, Effect, FileSystem, Schema } from 'effect';

/** A failed transaction never reaches the committed owner read or publishes a handoff. */
export const publishSalesDemoRolesAfterCommit = Effect.fn('PartySalesDemo.publishAfterCommit')(
  function* publishAfterCommit<CommitError, CommitRequirements, ReadError, ReadRequirements>(options: {
    readonly commit: Effect.Effect<void, CommitError, CommitRequirements>;
    readonly input: SalesDemoSeedInput;
    readonly observe: Effect.Effect<SalesDemoCustomerRoles, ReadError, ReadRequirements>;
    readonly outputPath: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    if (yield* fs.exists(options.outputPath)) {
      return yield* new SalesDemoFixtureInvalid({ reason: 'The explicit role handoff output already exists' });
    }
    yield* options.commit;
    const roles = yield* options.observe;
    const validated = yield* validateSalesDemoCustomerRoles(options.input, roles, yield* DateTime.now);
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(SalesDemoCustomerRolesSchema))(validated);
    yield* fs.writeFileString(options.outputPath, encoded, { flag: 'wx', mode: 0o600 });
    return yield* Effect.void;
  },
);
