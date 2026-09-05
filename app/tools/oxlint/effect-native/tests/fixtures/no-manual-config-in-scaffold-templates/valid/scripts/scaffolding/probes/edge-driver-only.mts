import { readFileSync } from 'node:fs';

/** In scope, no template literal at all: the generator's own plumbing stays this rule's non-business. */
export const loadManifest = (path: string): Record<string, unknown> => {
	const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error('generator manifest must be a JSON object');
	}
	const registry = new URL(process.env.ONTOS_GENERATOR_REGISTRY ?? 'https://example.invalid');
	return { ...parsed, registry: registry.href };
};
