import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  packageContentRevisions,
  packageOptionRoleRevisions,
  productVariantRevisions,
} from '../../src/database/schema.ts';
import { packageHistoryForScope } from '../../src/persistence/package-persistence.ts';
import { packageOptionHistoryForScope } from '../../src/persistence/package-option-persistence.ts';
import { variantHistoryForScope } from '../../src/persistence/variant-persistence.ts';

const tenantId = '00000000-0000-4000-8000-000000000001';
const resourceId = '00000000-0000-4000-8000-000000000002';
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:form-history-test:run:1',
    authMethod: 'system',
    principalId: '00000000-0000-4000-8000-000000000003',
    tenantId,
  }),
  correlationId: 'form-history-test',
};

type RevisionTable =
  | typeof productVariantRevisions
  | typeof packageContentRevisions
  | typeof packageOptionRoleRevisions;
const transactionFor = <Row>(expectedTable: RevisionTable, rows: readonly Row[]) => {
  const limit = () => Effect.succeed(rows);
  const where = () => ({ limit });
  const from = (table: RevisionTable) => {
    expect(table).toBe(expectedTable);
    return { where };
  };
  const select = () => ({ from });
  return { select };
};

describe('Catalog retained form revision reads', () => {
  it.effect('reads the exact Variant revision row without consulting Current', () =>
    Effect.gen(function* variantHistoryCase() {
      const retained = {
        combinationKey: 'red',
        lifecycleState: 'ACTIVE',
        productId: '00000000-0000-4000-8000-000000000004',
        recordedAt: new Date('2026-09-01T10:00:00.000Z'),
        revision: 1,
      };
      // @ts-expect-error SAFETY: mock supplies only the exact revision-select chain.
      const service = variantHistoryForScope(transactionFor(productVariantRevisions, [retained]), scope);
      const result = yield* service.getRevision(resourceId, 1);
      expect(Option.getOrThrow(result)).toBe(retained);
      // @ts-expect-error SAFETY: mock supplies only the exact revision-select chain.
      const missing = variantHistoryForScope(transactionFor(productVariantRevisions, []), scope);
      expect(Option.isNone(yield* missing.getRevision(resourceId, 2))).toBe(true);
    }),
  );

  it.effect('retains exact Package content and pinned lower revision, not Current content', () =>
    Effect.gen(function* packageHistoryCase() {
      const retained = {
        amount: '10',
        lowerPackageDefinitionId: '00000000-0000-4000-8000-000000000005',
        lowerRevision: 3,
        recordedAt: new Date('2026-09-01T10:00:00.000Z'),
        revision: 1,
      };
      // @ts-expect-error SAFETY: mock supplies only the exact revision-select chain.
      const service = packageHistoryForScope(transactionFor(packageContentRevisions, [retained]), scope);
      expect(Option.getOrThrow(yield* service.getContentRevision(resourceId, 1))).toBe(retained);
    }),
  );

  it.effect('reads an Option role revision separately from its pinned content revision', () =>
    Effect.gen(function* optionHistoryCase() {
      const retained = {
        contentRevision: 1,
        recordedAt: new Date('2026-09-01T10:00:00.000Z'),
        revision: 2,
        state: 'RETIRED',
      };
      // @ts-expect-error SAFETY: mock supplies only the exact revision-select chain.
      const service = packageOptionHistoryForScope(transactionFor(packageOptionRoleRevisions, [retained]), scope);
      expect(Option.getOrThrow(yield* service.getRoleRevision(resourceId, 2))).toBe(retained);
    }),
  );
});
