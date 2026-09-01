import { PROJECTS_SCHEMA_NAME, PROJECTS_TABLE_INVENTORY } from './schema.ts';

export const expectedProjectsTableCatalog = PROJECTS_TABLE_INVENTORY.map(
  (name) => `${PROJECTS_SCHEMA_NAME}.${name}`,
);

export const compareProjectsCatalog = (qualifiedNames: readonly string[]) => {
  const actual = new Set(qualifiedNames);
  const expected = new Set(expectedProjectsTableCatalog);
  return {
    missing: [...expected].filter((name) => !actual.has(name)).toSorted(),
    unexpected: [...actual].filter((name) => !expected.has(name)).toSorted(),
  } as const;
};
