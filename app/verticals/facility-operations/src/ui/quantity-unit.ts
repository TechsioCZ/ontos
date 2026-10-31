const czechPlurals = new Intl.PluralRules('cs');

type QuantityForms = Readonly<Partial<Record<Intl.LDMLPluralRule, string>>>;
const quantityForms = new Map<string, QuantityForms>([
  ['kanystr', { few: 'kanystry', many: 'kanystru', one: 'kanystr', other: 'kanystrů' }],
  ['karton', { few: 'kartony', many: 'kartonu', one: 'karton', other: 'kartonů' }],
  ['pytel', { few: 'pytle', many: 'pytle', one: 'pytel', other: 'pytlů' }],
  ['role', { few: 'role', many: 'role', one: 'role', other: 'rolí' }],
]);

/** Decline spelled-out Czech stock units; preserve abbreviations and custom units. */
export const quantityUnitLabel = (value: number, unit: string): string =>
  quantityForms.get(unit)?.[czechPlurals.select(value)] ?? unit;
