// expect-count: 1
/** Plain-JS scaffold under `scripts/scaffolding/**`. */
export const renderBoundary = (id) => `
const issuer = process.env.ONTOS_GATEWAY_ISSUER;
export const audience = '${id}';
`;
