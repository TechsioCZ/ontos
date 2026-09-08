// expect-count: 5
// C1 evidence shape: equality by serialized text and identity/hash keys.
const seen = new Map<string, number>();
const bucket: Record<string, boolean> = {};

export const sameScope = (left: unknown, right: unknown): boolean =>
	JSON.stringify(left) === JSON.stringify(right);

export const remember = (value: unknown, at: number): void => {
	seen.set(JSON.stringify(value), at);
};

export const impersonationCacheKey = JSON.stringify({ tenant: "acme", actor: "root" });

export const mark = (value: unknown): void => {
	bucket[JSON.stringify(value)] = true;
};
