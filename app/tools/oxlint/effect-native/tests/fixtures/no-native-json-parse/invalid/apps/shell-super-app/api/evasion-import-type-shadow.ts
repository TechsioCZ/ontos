// expect-count: 2
// A type-only import binding named `JSON` is erased at runtime, so the value-space global is
// still what executes. `import type` / inline `type` specifiers must not silence the rule.
import type { TopologyDocument as JSON } from "./topology-types.ts";

declare const s: string;

export const one = JSON.parse(s) as JSON;
export function nested(): JSON {
	return JSON.parse(s) as JSON;
}
