"""Temporary test refinements, excluded from the product PR."""
from pathlib import Path
app = Path(__file__).resolve().parents[1] / 'app'
def replace(path, old, new):
    source = path.read_text()
    assert source.count(old) == 1, (str(path), source.count(old), old)
    path.write_text(source.replace(old, new))
p = app / 'scripts/tests/zerops-migrator-owner-coverage.test.mts'
replace(p, "from '@rstest/core'", "from 'effect-rstest'")
p.write_text(p.read_text().replace("'utf8'", "'utf-8'"))
replace(p, 'const migratorDeployment = deployment.split("  - setup: \'spicedb\'")[0];',
           'const [migratorDeployment] = deployment.split("  - setup: \'spicedb\'");')
p = app / 'verticals/commerce-customer-context/tests/unit/price-group-currentness-regressions.test.ts'
replace(p, "import { Effect, Schema } from 'effect';", "import { Effect, Match, Schema } from 'effect';")
replace(p, "import type { CustomerPriceGroupAssignment }", "import type { CustomerPriceGroupAssignment, PriceGroupCompatibilityEvidence }")
replace(p, "    expect(resolved).toMatchObject({ _tag: 'ASSIGNED', compatibility: freshEvidence });",
'''    expect(Match.value(resolved).pipe(
      Match.tag('ASSIGNED', ({ compatibility }) => compatibility),
      Match.orElse(() => undefined),
    )).toEqual(freshEvidence);''')
replace(p, "    expect(resolved).toMatchObject({ _tag: 'BROKEN', reason: 'INCOMPATIBLE', catalogRevision: 2 });",
'''    expect(Match.value(resolved).pipe(
      Match.tag('BROKEN', ({ catalogRevision, reason }) => ({ catalogRevision, reason })),
      Match.orElse(() => undefined),
    )).toEqual({ catalogRevision: 2, reason: 'INCOMPATIBLE' });''')
replace(p, 'readonly effectiveFrom: string; readonly trustedOperationAt: string',
           "readonly effectiveFrom: CustomerPriceGroupAssignment['effectiveFrom']; readonly trustedOperationAt: PriceGroupCompatibilityEvidence['trustedOperationAt']")
p = app / 'verticals/price-group-catalog/tests/integration/governed-routine-behavior.test.ts'
p.write_text("import { randomUUID } from 'node:crypto';\n\n" + p.read_text())
p = app / 'verticals/price-group-catalog/tests/integration/price-group-currentness-regressions.test.ts'
replace(p, "import { scopedRoutineInvokerFromTransaction } from '@app/core-runtime';",
           "import { scopedRoutineInvokerFromTransaction } from '@app/core-runtime';\nimport type { OperationalScope } from '@app/core-runtime';\nimport type { PriceGroupCatalogTransaction } from '../../src/database/types.ts';")
replace(p, 'const fixture = Effect.gen(function* priceGroupFixture() {',
'''const invokerForTransaction = (transaction: PriceGroupCatalogTransaction, scope: OperationalScope) =>
  scopedRoutineInvokerFromTransaction((statement) => transaction.execute(statement, 'objects'), scope);

const fixture = Effect.gen(function* priceGroupFixture() {''')
replace(p, "      const invoker = scopedRoutineInvokerFromTransaction((statement) => transaction.execute(statement, 'objects'), scope);",
           '      const invoker = invokerForTransaction(transaction, scope);')
