/** tools/** is owned by the S1/A3/A4 throw rules, not by no-throw-in-scripts. */
export function assertRuleName(name: string): string {
	if (name === "") throw new Error("rule name is required");
	return name;
}
