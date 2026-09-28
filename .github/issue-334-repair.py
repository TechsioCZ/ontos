"""Temporary isolated repair driver; excluded from the product PR."""
from pathlib import Path
import subprocess
root = Path(__file__).resolve().parents[1]
app = root / 'app'
commerce = app / 'verticals/commerce-customer-context'
catalog = app / 'verticals/price-group-catalog'

def replace(path, old, new, count=1):
    source = path.read_text()
    assert source.count(old) == count, (str(path), source.count(old), old[:100])
    path.write_text(source.replace(old, new))

replace(commerce / 'shared/domain/price-group-resolution.ts',
        '      effectiveAt,\n      assignment.compatibility,\n', '      effectiveAt,\n')
replace(commerce / 'shared/domain/price-group-resolution.ts',
        '    const outcome = yield* catalog.resolveCurrent(',
        '    // The assignment keeps its accepted evidence. Each consumption obtains fresh owner truth;\n'
        '    // only an expectation from this operation may be used as a Current concurrency fence.\n'
        '    const outcome = yield* catalog.resolveCurrent(')

for file, helper in [
    ('assign-customer-price-group.action.ts', 'resolveAssignableCatalogPriceGroup'),
    ('migrate-customer-price-group.action.ts', 'resolveMigrationCatalogPriceGroup'),
]:
    path = commerce / 'src/actions' / file
    source = path.read_text()
    start = source.index(f'const {helper} =')
    end = source.index('\n});', start) + len('\n});')
    old = source[start:end]
    new = old.replace('context: AssignCustomerPriceGroupContext)', 'context: AssignCustomerPriceGroupContext, trustedOperationAt: string)')
    new = new.replace('context: MigrateCustomerPriceGroupContext)', 'context: MigrateCustomerPriceGroupContext, trustedOperationAt: string)')
    assert new != old
    assert new.count('    payload.effectiveFrom,') == 1
    new = new.replace('    payload.effectiveFrom,', '    trustedOperationAt,')
    replace(path, old, new)
    replace(path, f'{helper}(payload, context);', f'{helper}(payload, context, recordedAt);')

for file, payload, helper, ref in [
    ('assign-counterparty-price-group.action.ts', 'AssignCounterpartyPriceGroupPayload', 'resolveAssignCounterpartyPriceGroupCatalog', 'priceGroupRef'),
    ('migrate-counterparty-price-group.action.ts', 'MigrateCounterpartyPriceGroupPayload', 'resolveMigrateCounterpartyPriceGroupCatalog', 'targetPriceGroupRef'),
]:
    path = commerce / 'src/actions' / file
    replace(path, f"  effectiveFrom: {payload}['effectiveFrom'],\n  catalog: PriceGroupCatalogPort,",
            "  trustedOperationAt: string,\n  catalog: PriceGroupCatalogPort,")
    replace(path, '    CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT,\n    effectiveFrom,',
            '    CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT,\n    trustedOperationAt,')
    replace(path, f'{helper}(\n    payload.{ref},\n    payload.effectiveFrom,',
            f'{helper}(\n    payload.{ref},\n    recordedAt,')

revision_sql = (catalog / 'drizzle/20260923232604_preserve_pre_retirement_revisions/migration.sql').read_text()
start = revision_sql.index('    IF v_group.current_definition_schedule_revision = v_retirement_catalog_revision THEN')
end = revision_sql.index('\n  END IF;\n  IF v_expected_schedule', start)
revision_sql = revision_sql[:start] + revision_sql[end:]
revision_sql = revision_sql.replace('-- Preserve valid pre-retirement definition scheduling after retirement acceptance advances the group schedule.',
    '-- B3: Read and write share the exact Current schedule fence, including accepted retirement.\n'
    '-- Stale evidence is never silently translated into a newer schedule.')

history_sql = (catalog / 'drizzle/20260923195452_owner_semantic_continuity/migration.sql').read_text()
start = history_sql.index('CREATE FUNCTION "price_group_catalog"."read_definition_revision_with_retirement"(')
end = history_sql.index('$function$;', start) + len('$function$;')
history_sql = history_sql[start:end].replace('CREATE FUNCTION ', 'CREATE OR REPLACE FUNCTION ', 1)
history_sql = history_sql.replace('  v_definition jsonb;', '  v_definition jsonb;\n  v_accepted_schedule bigint;', 1)
old = '''  IF NOT EXISTS (SELECT 1 FROM price_group_catalog.price_group_definition_revisions AS definition
    WHERE definition.tenant_id = p_tenant_id AND definition.price_group_id = p_price_group_id
      AND definition.definition_revision_id = p_definition_revision_id) THEN'''
new = '''  SELECT definition.accepted_catalog_revision INTO v_accepted_schedule
  FROM price_group_catalog.price_group_definition_revisions AS definition
  WHERE definition.tenant_id = p_tenant_id AND definition.price_group_id = p_price_group_id
    AND definition.definition_revision_id = p_definition_revision_id;
  IF NOT FOUND THEN'''
assert history_sql.count(old) == 1
history_sql = history_sql.replace(old, new)
old = 'p_tenant_id, p_price_group_id, p_definition_revision_id, v_group.current_definition_schedule_revision'
assert history_sql.count(old) == 1
history_sql = history_sql.replace(old, 'p_tenant_id, p_price_group_id, p_definition_revision_id, v_accepted_schedule')
history_sql = ('-- B4: Exact historical reads return the immutable accepted definition/schedule.\n'
    '-- Current lifecycle and retirement evidence stay separate: an accepted future plan is not\n'
    '-- proof it became effective. Missing accepted evidence fails closed; never fall back to latest.\n' + history_sql)
sql_text = revision_sql.rstrip() + '\n' + history_sql + '\n--> statement-breakpoint\n'
subprocess.run(['mise', 'exec', '--', 'pnpm', '--filter', '@app/price-group-catalog',
                'exec', 'drizzle-kit', 'generate', '--config', 'drizzle.config.ts', '--custom',
                '--name', 'restore_price_group_current_history'], cwd=app, check=True)
existing = list((catalog / 'drizzle').glob('*_restore_price_group_current_history'))
assert len(existing) == 1
(existing[0] / 'migration.sql').write_text(sql_text)

replace(app / 'packages/price-group-catalog-contracts/src/apis/price-group-definition.ts',
        "    selection: Schema.Literal('HISTORICAL'),",
        "    // Exact revision/schedule as accepted; not a claim of Current or eventual usability.\n"
        "    // identity.lifecycle and scheduledRetirement independently describe the lifecycle.\n"
        "    selection: Schema.Literal('HISTORICAL'),")

path = catalog / 'tests/integration/governed-routine-behavior.test.ts'
replace(path, "expect(supersededRevision.definition.effectivePeriod.effectiveTo).toBe('2026-09-15T00:00:00.000Z');",
        'expect(supersededRevision.definition).toEqual(created);')
source = path.read_text()
start = source.index('      const preRetirementRevision =')
end = source.index('      expect(preRetirementRevision.acceptedCatalogRevision)', start)
old = source[start:end]
new = old.replace('catalogRevision: competingGroup.acceptedCatalogRevision,',
                  'catalogRevision: unchangedAfterShortRevision.catalogRevision,')
assert new != old
replace(path, old, new)
source = path.read_text()
start = source.index('      // The tenant lock runs the two routines in either order.')
end = source.index('      expect(raceRevision.definitionRevisionId)', start)
old = source[start:end]
new = '''      // Either the bounded revision is rejected before retirement, or its expectation is
      // stale after retirement. Neither order may silently translate an old concurrency fence.
      expect(Result.isSuccess(raceRetirementResult)).toBe(true);
      expect(Result.isFailure(raceRevisionResult)).toBe(true);
      if (Result.isFailure(raceRevisionResult)) {
        expect(
          Schema.is(PriceGroupEffectivePeriodConflict)(raceRevisionResult.failure) ||
          Schema.is(PriceGroupExpectedCurrentConflict)(raceRevisionResult.failure),
        ).toBe(true);
      }
      const freshRace = yield* inScope((invoker) =>
        priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).readCurrentDefinition(
          raceGroup.priceGroupRef,
          raceRevisionInput.trustedEffectiveAt,
        ),
      );
      const raceRevision = yield* inScope((invoker) =>
        priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).createDefinitionRevision({
          ...raceRevisionInput,
          actionInvocationId: randomUUID(),
          expectedCurrent: {
            catalogRevision: freshRace.catalogRevision,
            definitionRevisionId: freshRace.definition.definitionRevisionId,
            definitionRevisionNumber: freshRace.definition.revisionNumber,
            meaningFingerprint: freshRace.definition.meaningFingerprint,
            priceGroupRef: freshRace.definition.priceGroupRef,
          },
        }),
      );
'''
replace(path, old, new)
replace(path, 'and schedule_catalog_revision = ${retirement.acceptedCatalogRevision}',
        'and schedule_catalog_revision = ${created.acceptedCatalogRevision}')

path = commerce / 'tests/unit/price-group-actions.test.ts'
replace(path, 'threads one validated scheduled instant through profile, catalog, and persistence',
        'keeps scheduling time separate from Current catalog verification time')
source = path.read_text()
start = source.index("it.effect('keeps scheduling time separate")
end = source.index('\n  it.effect(', start)
old = source[start:end]
new = old.replace('definitionEffectivePeriod: { effectiveFrom, effectiveTo: null },',
                  'definitionEffectivePeriod: { effectiveFrom: recordedAt, effectiveTo: null },')
new = new.replace('trustedOperationAt: effectiveFrom,', 'trustedOperationAt: recordedAt,')
new = new.replace('verifiedAt: effectiveFrom,', 'verifiedAt: recordedAt,')
new = new.replace('`catalog:${effectiveFrom}`', '`catalog:${recordedAt}`')
replace(path, old, new)

path = app / 'scripts/run-zerops-migrator.mjs'
replace(path, "    yield* migrate('verticals/payment-term-catalog', 'drizzle.config.ts');",
        "    yield* migrate('verticals/payment-term-catalog', 'drizzle.config.ts');\n"
        "    yield* migrate('verticals/price-group-catalog', 'drizzle.config.ts');")
replace(path, "    yield* migrate('verticals/commerce-customer-context', 'drizzle.config.ts');",
        "    yield* migrate('verticals/commerce-customer-context', 'drizzle.config.ts');\n"
        "    yield* migrate('verticals/commerce-market-catalog', 'drizzle.config.ts');")
replace(path, "    yield* migrate('verticals/catalog', 'drizzle.config.ts');",
        "    yield* migrate('verticals/catalog', 'drizzle.config.ts');\n"
        "    yield* migrate('verticals/pricing', 'drizzle.config.ts');\n"
        "    yield* migrate('verticals/storefront-registry', 'drizzle.config.ts');")
path = app / 'zerops.yaml'
replace(path, "        - 'app/verticals/commerce-customer-context'\n",
        "        - 'app/verticals/commerce-customer-context'\n        - 'app/verticals/commerce-market-catalog'\n")
replace(path, "        - 'app/verticals/price-group-catalog'\n",
        "        - 'app/verticals/price-group-catalog'\n        - 'app/verticals/pricing'\n        - 'app/verticals/storefront-registry'\n")
replace(commerce / 'tests/unit/price-group-currentness-regressions.test.ts',
        "import type { ActionAccessEvidencePolicy, DomainEventContractMap } from '@app/core-runtime';",
        "import type { ActionAccessEvidencePolicy } from '@app/core-runtime';\n"
        "import type { DomainEventContractMap } from '../../../../packages/core-runtime/src/actions/events.ts';")
print('Applied B1-B4 and code-side migration wiring; stage was not modified.')
