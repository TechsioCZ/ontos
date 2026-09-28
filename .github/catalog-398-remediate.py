"""Temporary, branch-only audit workbench. Removed from the final PR diff."""
from pathlib import Path
import sys

ROOT = Path('app/verticals/catalog')

def replace_once(relative, before, after):
    path = ROOT / relative
    text = path.read_text()
    if text.count(before) != 1:
        raise RuntimeError(f'{relative}: expected exactly one reviewed source block, found {text.count(before)}')
    path.write_text(text.replace(before, after, 1))

def append_once(relative, marker, text):
    path = ROOT / relative
    original = path.read_text()
    if marker in original:
        raise RuntimeError(f'{relative}: reproduction already exists; reassess baseline')
    path.write_text(original.rstrip() + '\n\n' + text.strip() + '\n')

if sys.argv[1] == 'tests':
    append_once('tests/unit/product-configuration.test.ts', 'F6 preserves the sign', r'''
describe('Catalog audit signed configuration identity', () => {
  it('F6 preserves the sign of nonzero fractional configurations', () => {
    const measured = (amount: string): ProductConfiguration => ({
      ...selected,
      values: [
        { choiceKey: 'mount', kind: 'SINGLE_CHOICE', optionKey: 'A' },
        { amount, choiceKey: 'length', kind: 'MEASURED_VALUE', unitRef },
      ],
    });
    for (const [left, right, same] of [
      ['-0.5', '0.5', false],
      ['-0.01', '0.01', false],
      ['-0.500', '-0.5', true],
      ['-0.000', '0', true],
      ['-0', '0.000', true],
      ['1.0', '1.000', true],
      ['-1.0', '-1.000', true],
    ] as const) {
      expect(sameProductConfigurationSelection(measured(left), measured(right), definition)).toMatchObject({
        same,
        status: 'VALID',
      });
      expect(
        sameProductConfigurationSelectionAcrossRevisions(measured(left), definition, measured(right), definition),
      ).toMatchObject({ same, status: 'VALID' });
    }
  });
});
''')
    append_once('tests/unit/variant-persistence.test.ts', 'F2 rejects retired combination', r'''
it.effect('F2 rejects retired combination confirmation before dependent reads or writes', () =>
  Effect.gen(function* rejectRetiredConfirmation() {
    const writes: string[] = [];
    const reads: string[] = [];
    const transaction = {
      insert: () => {
        writes.push('insert');
        throw new Error('Retired confirmation must not append a revision');
      },
      select: () => ({
        from: (table: typeof products | typeof productVariants) => {
          if (table === products) {
            reads.push('product');
            return lockedRow({ ...row, lifecycleState: 'ACTIVE' });
          }
          expect(table).toBe(productVariants);
          reads.push('variant');
          return lockedRow({ ...row, lifecycleState: 'RETIRED' });
        },
      }),
      update: () => {
        writes.push('update');
        throw new Error('Retired confirmation must not update a Variant');
      },
    };
    // @ts-expect-error Only the owner reads permitted before lifecycle rejection are supplied.
    const service = variantPersistenceForScope(transaction, scope);
    const result = yield* service.confirm({
      ...evidence,
      expectedAxisRevision: 1,
      expectedVariantRevision: 1,
      productRef,
      variantRef,
    });
    expect(
      Match.value(result).pipe(
        Match.tag('lifecycle_conflict', () => true),
        Match.orElse(() => false),
      ),
    ).toBe(true);
    expect(reads).toEqual(['product', 'variant']);
    expect(writes).toEqual([]);
  }),
);
''')
elif sys.argv[1] == 'fixes':
    replace_once('shared/domain/product-configuration.ts',
                 "const normalizedWhole = whole === '-0' ? '0' : whole;",
                 "const normalizedWhole = whole === '-0' && trimmed.length === 0 ? '0' : whole;")
    path = ROOT / 'src/persistence/variant-persistence.ts'
    text = path.read_text()
    marker = "  const confirm: VariantPersistence['confirm'] ="
    if text.count(marker) != 1:
        raise RuntimeError('Variant confirm boundary is not unique')
    prefix, tail = text.split(marker, 1)
    before = """    if (row.currentRevision !== input.expectedVariantRevision) {
      return { _tag: 'revision_conflict', actualRevision: row.currentRevision };
    }
"""
    after = before + """    // Confirmation is not reactivation: retired forms must pass the separate Current-use assessment.
    if (row.lifecycleState === 'RETIRED') {
      return { _tag: 'lifecycle_conflict' };
    }
"""
    if tail.count(before) != 1:
        raise RuntimeError('Variant confirm revision guard changed')
    path.write_text(prefix + marker + tail.replace(before, after, 1))
else:
    raise RuntimeError('Expected tests or fixes')
