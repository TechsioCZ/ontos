// expect-count: 3
/**
 * A8/A9 evasion: emitted browser code is Promise-first without using any of the six literal tokens.
 * `new Promise<void>(` defeats `\bnew Promise\(` because of the type argument, and `Promise.all(` /
 * `Promise.resolve(` are not in the pattern list at all.
 */
export const renderLoader = (name: string): string => `import { ${name}Api } from './api.ts';

export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const loadAll = (ids: ReadonlyArray<string>) =>
  Promise.all(ids.map((id) => ${name}Api.read(id)));

export const loadFirst = (id: string) =>
  Promise.resolve(${name}Api.read(id)).catch(() => undefined);
`;
