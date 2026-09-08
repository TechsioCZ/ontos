// Regression fixture for a false positive found by adversarial review.
//
// `JSON.parse(JSON.stringify(value))` is the native structured-clone idiom: there is no JSON *text*
// input, no external/untrusted document, no realistic `SyntaxError`, and no "validate later" step —
// so the rule's remedy (`Schema.fromJsonString`) is not applicable. The audit's D tier keeps
// "native array/object operations where Effect collection APIs add no semantic value"; the correct
// non-Effect fix here is `structuredClone`, not a Schema codec.
//
// Real occurrence: scripts/materialize-zerops-runtime.mjs:259
//   const installPackage = JSON.parse(JSON.stringify(runtimePackage));
//
// Suggested detection change: skip a `JSON.parse` CallExpression whose single argument unwraps to a
// `JSON.stringify(...)` call. Every other `JSON.parse` form must keep reporting.

interface RuntimePackage {
	readonly dependencies: Record<string, string>;
	readonly name: string;
}

export const cloneRuntimePackage = (runtimePackage: RuntimePackage): RuntimePackage =>
	JSON.parse(JSON.stringify(runtimePackage)) as RuntimePackage;

export const cloneViaGlobalThis = (value: RuntimePackage): RuntimePackage =>
	globalThis.JSON.parse(globalThis.JSON.stringify(value)) as RuntimePackage;
