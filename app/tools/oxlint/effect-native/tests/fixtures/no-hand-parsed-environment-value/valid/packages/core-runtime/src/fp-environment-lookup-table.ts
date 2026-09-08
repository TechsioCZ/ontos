// FALSE POSITIVE regression fixture (adversarial review).
//
// `environment` here is a deployment-environment -> origin lookup table whose values are hard coded
// literals. Because `isEnvironmentRead` treats *any* computed non-literal key on an identifier
// matching `environmentIdentifiers` as an environment read, `environment[name]` is classified as a
// configuration read and every operation on it is reported.
//
// This is the shape a `let environment = cloudflareDeployEnabled ? 'production' : 'development'`
// (apps/shell-super-app/module-deployment-allowlist.config.ts:50) turns into the moment someone
// promotes it to a table, so the rule would start reporting a refactor that removes no ambient
// configuration at all. A declarator resolving to an ObjectExpression with no environment-derived
// property should rebut the name match.
const environment = {
	development: 'http://localhost:3020',
	production: 'https://app.example.com',
} as const;

type DeploymentEnvironment = keyof typeof environment;

export const originFor = (name: DeploymentEnvironment): URL => new URL(environment[name]);
export const isLoopback = (name: DeploymentEnvironment): boolean =>
	environment[name].startsWith('http://localhost');
