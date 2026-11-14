import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createModuleGraph } from '@modern-js/code-tools/microvertical-api-boundary';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { hasPublishedUiSupport } from '../published-ui-support.mts';

const hookImport = "import { useState } from 'react';";
const importedSupport = "import { used } from './support.ts';";
const supportExports = "export { used, unrelated } from './support.ts';";
const realHook = "export const Controls = () => { const [value] = useState('ready'); return used(value); };";

const proveSupport = (source: string, name: string) =>
  Effect.scoped(
    Effect.gen(function* supportFixture() {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), 'published-ui-support-'))),
        (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
      );
      yield* Effect.promise(() =>
        writeFile(path.join(root, 'package.json'), '{"name":"ui-support-test","type":"module"}'),
      );
      yield* Effect.promise(() =>
        writeFile(
          path.join(root, 'support.ts'),
          'export const used = (value: string) => value; export const unrelated = () => true;',
        ),
      );
      yield* Effect.promise(() => writeFile(path.join(root, 'controls.tsx'), source));
      const graph = createModuleGraph();
      const artifact = graph.module(path.join(root, 'controls.tsx'));
      const selected = graph.resolve(graph.module(path.join(root, 'support.ts')), name, 'export');
      return selected?.kind === 'declaration' && hasPublishedUiSupport({ artifact, graph, selected });
    }),
  );

for (const [name, source, symbol, accepted] of [
  ['original React hook dependency', `${hookImport}\n${importedSupport}\n${supportExports}\n${realHook}`, 'used', true],
  [
    'JSX component dependency',
    `${importedSupport}\n${supportExports}\nexport const Controls = () => <span>{used('ready')}</span>;`,
    'used',
    true,
  ],
  ['unrelated co-export', `${hookImport}\n${importedSupport}\n${supportExports}\n${realHook}`, 'unrelated', false],
  [
    'forged React hook',
    `import { useState } from 'forged-react';\n${importedSupport}\n${supportExports}\n${realHook}`,
    'used',
    false,
  ],
  [
    'hook-shaped name without UI',
    `${importedSupport}\n${supportExports}\nexport const useControls = () => used('ready');`,
    'used',
    false,
  ],
  [
    'shadowed support reference',
    `${hookImport}\n${importedSupport}\n${supportExports}\nexport const Controls = (used: (value: string) => string) => { const [value] = useState('ready'); return used(value); };`,
    'used',
    false,
  ],
] as const) {
  it.live(`checks published UI support ${name}`, () =>
    Effect.gen(function* uiSupportIdentity() {
      expect(yield* proveSupport(source, symbol)).toBe(accepted);
    }),
  );
}
