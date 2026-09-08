// expect-count: 2
// A7: build injection of topology and allowlist documents.
const referenceTopology = { modules: ["contacts", "party-registry"] };

export default {
	source: {
		globalVars: { "process.env.REFERENCE_TOPOLOGY": JSON.stringify(referenceTopology) },
	},
	tools: {
		rspack: { define: { __DEPLOYMENT_ALLOWLIST__: JSON.stringify({ allow: [] as string[] }) } },
	},
};
