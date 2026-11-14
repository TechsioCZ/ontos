import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Cause, Effect, Exit } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  CUSTOMER_CONTEXT_PRIVATE_CONTRACT_PATH,
  checkModuleEntrypointBoundaries,
  makeActualCustomerContextAggregateFixture,
  write,
} from './module-entrypoint-boundaries.fixture.mts';

for (const privateSelection of [false, true]) {
  it.live(`checks actual Customer Context public aggregate private=${privateSelection}`, () =>
    Effect.gen(function* actualCustomerContextAggregate() {
      const root = yield* makeActualCustomerContextAggregateFixture();
      const apiFile = 'verticals/commerce-customer-context/shared/api.ts';
      const privateOrigin = CUSTOMER_CONTEXT_PRIVATE_CONTRACT_PATH;
      yield* write(root, privateOrigin, 'export const privateAggregateHandler = () => true;\n');
      if (privateSelection) {
        const source = yield* Effect.promise(() => readFile(path.join(root, apiFile), 'utf-8'));
        yield* write(
          root,
          apiFile,
          `${source}\nexport { privateAggregateHandler } from '../src/handlers/private-contract.ts';\n`,
        );
      }
      const binding = privateSelection ? 'privateAggregateHandler' : 'commerceCustomerContextApi';
      yield* write(
        root,
        'apps/shell-super-app/src/customer-context-aggregate-consumer.ts',
        `import { ${binding} } from '@app/commerce-customer-context/api';\n`,
      );
      const result = yield* Effect.exit(checkModuleEntrypointBoundaries(root));
      expect(Exit.isSuccess(result), Exit.isFailure(result) ? Cause.pretty(result.cause) : binding).toBe(
        !privateSelection,
      );
      if (privateSelection && Exit.isFailure(result)) {
        expect(Cause.pretty(result.cause)).toContain(privateOrigin);
      }
    }),
  );
}
