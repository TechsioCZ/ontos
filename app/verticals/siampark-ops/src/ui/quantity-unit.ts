const czechPlurals = new Intl.PluralRules('cs');

const quantityForms: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  karton: { one: 'karton', few: 'kartony', many: 'kartonu', other: 'kartonů' },
  role: { one: 'role', few: 'role', many: 'role', other: 'rolí' },
  pytel: { one: 'pytel', few: 'pytle', many: 'pytle', other: 'pytlů' },
  kanystr: { one: 'kanystr', few: 'kanystry', many: 'kanystru', other: 'kanystrů' },
};

/** Decline spelled-out Czech stock units; preserve abbreviations and custom units. */
export const quantityUnitLabel = (value: number, unit: string): string =>
  quantityForms[unit]?.[czechPlurals.select(value)] ?? unit;
