// EVASION (lowest confidence - drop this fixture if you decline it): hoisting the SQLSTATE classes
// into an array makes the `startsWith` argument an Identifier, so axis 6 sees no two-digit literal.
// Fix must be call-shaped, not literal-shaped: an array/Set of two-digit strings that is the
// receiver of `.some/.every/.find/.filter` whose callback calls `startsWith`/`endsWith`. A bare
// array of two-digit strings must stay silent - see valid/.../edge/edge-two-digit-strings.ts.
const RETRYABLE_CLASSES = ['08', '40', '53', '55', '57', '58'];
export const retryable = (code: string): boolean =>
	RETRYABLE_CLASSES.some((sqlStateClass) => code.startsWith(sqlStateClass));
