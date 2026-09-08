/**
 * The generator's own driver code: progress logging, a path template and a shell command. None of this
 * text is ever emitted into a generated module, and the rule documents that only emitted text is
 * scanned ("the generator's own code ... is the script's own business").
 */
import { relative } from 'node:path';

export const reportProgress = (root: string, written: readonly string[]): void => {
	console.log(`Wrote ${written.length} files under ${relative(root, 'src')}/async-handlers`);
	console.log(`Next: await review from the owning team before merging.`);
};

export const buildCommand = (name: string): string => `pnpm dlx create-microvertical ${name} --no-async`;
