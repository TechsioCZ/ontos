const EXPECTED_APPLICATION_SCHEMAS = ['auth', 'core', 'public'] as const;

/**
 * False positive reproduction — `scripts/verify-application-db-schema.mts:38`/`:43`,
 * `apps/shell-super-app/scripts/verify-auth-db-schema.mts:89`,
 * `scripts/check-authorization-readiness.mts:96`.
 *
 * Two already-sorted `readonly string[]` values, one of them a local literal constant. There is no
 * decoded document and no key set: this is array equality over Postgres catalog names. The audit lists
 * that under D tier ("native array operations where Effect collection APIs add no semantic value").
 */
export const schemasMatch = (actualSchemas: readonly string[]): boolean =>
	JSON.stringify(actualSchemas.toSorted()) === JSON.stringify([...EXPECTED_APPLICATION_SCHEMAS].toSorted());
