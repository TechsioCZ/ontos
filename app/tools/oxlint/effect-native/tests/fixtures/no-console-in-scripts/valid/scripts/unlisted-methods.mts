// Methods outside the reported `methods` option (assert/count/profile) are the rule's knob, not a
// silent hole: widen `methods` to include them.
export function inspect(value: unknown): void {
	console.assert(value !== undefined, "value is required");
	console.count("inspect");
	console.profile?.("inspect");
}

export function detect(): boolean {
	return typeof console !== "undefined";
}
