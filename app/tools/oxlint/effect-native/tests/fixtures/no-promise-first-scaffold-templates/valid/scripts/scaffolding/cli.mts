/**
 * The generator's own driver code may be Promise-first (Node process entrypoint, D tier) and may use
 * namespace or aliased Effect imports; only the text it *emits* is held to the A8/A9 target shape.
 */
import { readFile, writeFile } from 'node:fs/promises';

import * as Effect from 'effect/Effect';
import { Effect as Fx } from 'effect';

export const run = async (target: string): Promise<void> => {
	const manifest = await readFile('package.json', 'utf8');
	const registry = await fetch('https://registry.example.test/ontos').then((response) => response.text());
	await Effect.runPromise(Fx.logInfo(registry));
	await writeFile(target, renderModule(manifest), 'utf8');
};

const renderModule = (manifest: string): string => `export const manifest = ${JSON.stringify(manifest)};
`;
