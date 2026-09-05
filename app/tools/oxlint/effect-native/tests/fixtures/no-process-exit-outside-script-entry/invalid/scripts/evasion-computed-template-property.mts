// expect-count: 1
// Evasion probe: computed member access spelled with a substitution-free template literal.
// The rule already resolves `process["exit"]`; the template form is the adjacent spelling.
export const halt = (code: number): void => {
	process[`exit`](code);
};
