/** Same emitted code as the stale action-boundary template, assembled from string literals. */
const LINES: readonly string[] = [
	"const raw = process.env['ONTOS_GATEWAY_PUBLIC_JWKS'];",
	"const parsed = JSON.parse(raw ?? '{}');",
	"if (typeof parsed !== 'object') { throw configurationError('ONTOS_GATEWAY_PUBLIC_JWKS'); }",
];

export const renderBoundary = (appId: string): string =>
	LINES.join("\n") + "\nexport const audience = '" + appId + "';\n";
