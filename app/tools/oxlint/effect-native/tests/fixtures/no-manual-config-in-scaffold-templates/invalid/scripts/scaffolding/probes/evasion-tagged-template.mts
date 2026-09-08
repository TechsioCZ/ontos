// expect-count: 1
/** The emitted text sits in a tagged template, not a bare one. */
declare const dedent: (strings: TemplateStringsArray, ...values: readonly string[]) => string;

export const renderBoundary = (appId: string): string => dedent`
	const issuer = process.env.ONTOS_GATEWAY_ISSUER;
	export const audience = '${appId}';
`;
