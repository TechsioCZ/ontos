// `ignoreConfigFiles` (default true): a build-host configuration file whose failure protocol is a
// thrown Error. A7 targets the Schemas this file decodes through, not the throw at the build edge.
export default function defineConfig(topology: Record<string, unknown>) {
	if (typeof topology.verticals !== "object") {
		throw new TypeError("modern.config.ts requires a verticals map");
	}
	if (topology.environment === undefined) {
		throw new Error("modern.config.ts requires an environment");
	}
	return topology;
}
