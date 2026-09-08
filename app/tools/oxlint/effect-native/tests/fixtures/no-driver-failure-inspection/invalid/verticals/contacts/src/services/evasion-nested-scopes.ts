// expect-count: 2
// A5: use driver-specific sqlState in the nested callback; code alone is not driver evidence.
export class DriverProbe {
	static readonly retry = (error: Record<string, unknown>): boolean =>
		((inner: Record<string, unknown>) => 'sqlState' in inner)(error);

	async *walk(error: Record<string, unknown>): AsyncGenerator<unknown> {
		yield error?.cause;
	}
}
