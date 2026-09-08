/**
 * Regression: a single module-scope environment read marks the *module* as a configuration
 * parser, and `followLocalHelpers` then walks `maxHelperDepth` hops out of module scope into
 * every function the module body happens to call.
 *
 * `assertTenantId` validates a ULID-shaped identifier. It reads no environment value, takes no
 * environment record, and is exported for callers that have nothing to do with configuration.
 * Its throw is audit A4 territory (an untyped domain guard), not A3 — reporting it as
 * "a file-local helper reached only from a configuration parser" is false.
 *
 * Nothing at module scope throws, so the module's own configuration read is not a violation.
 */
const listenPort = Number(process.env["PORT"] ?? "3000");

export const assertTenantId = (identifier: string): string => {
	if (identifier.length !== 26) {
		throw new TypeError("tenant identifier must be a ULID");
	}
	return identifier;
};

const registerTenant = (identifier: string): string => assertTenantId(identifier);

export const defaultTenantId = registerTenant("01ARZ3NDEKTSV4RRFFQ69G5FAV");
export const port = listenPort;
