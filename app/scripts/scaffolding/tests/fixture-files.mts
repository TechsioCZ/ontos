import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const write = async (root: string, relativePath: string, content: string): Promise<void> => {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf-8');
};

export const snapshotTree = async (
  root: string,
  excludedDirectories: readonly string[] = [],
): Promise<Readonly<Record<string, string>>> => {
  const snapshot: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory() && !excludedDirectories.includes(entry.name)) {
          await visit(target);
        } else if (entry.isFile()) {
          snapshot[path.relative(root, target)] = await readFile(target, 'utf-8');
        }
      }),
    );
  };
  await visit(root);
  return snapshot;
};
