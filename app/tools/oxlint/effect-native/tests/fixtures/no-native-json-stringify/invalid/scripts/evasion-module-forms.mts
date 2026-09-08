// expect-count: 5
// `.mts` operational script: top-level await, default export, for-await, generator.
declare const v: unknown;

export const direct = JSON.stringify(v);

export const awaited = await Promise.resolve(JSON.stringify(v));

export async function drain(source: AsyncIterable<unknown>): Promise<void> {
	for await (const item of source) void JSON.stringify(item);
}

export function* lines(): Generator<string> {
	yield JSON.stringify(v);
}

export default JSON.stringify({ ok: true });
