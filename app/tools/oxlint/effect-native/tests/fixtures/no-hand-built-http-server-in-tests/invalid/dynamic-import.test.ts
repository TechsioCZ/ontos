// expect-count: 2
export async function load(): Promise<unknown> {
	const httpModule = await import("node:http");
	const netModule = await import(`node:net`);
	return [httpModule, netModule];
}
