/** `scripts/**\/__tests__/**` is deliberately out of scope (B2 owns the harness). */
export function expectThrows(run: () => void): void {
	try {
		run();
		throw new Error("expected a throw");
	} catch (error) {
		if (!(error instanceof Error)) throw error;
	}
}
