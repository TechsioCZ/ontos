// expect-count: 1
// Génère le module d'action — ✅ modèle à jour 😀 (non-ASCII before the template)
export const renderBoundary = (): string => `
const issuer = process.env.ONTOS_GATEWAY_ISSUER;
`;
