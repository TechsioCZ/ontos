import { mkdirSync, writeFileSync } from 'node:fs';
import nodePath from 'node:path';

import { expect, it } from 'effect-rstest';

import { appRoot, fixtureConfigPath, runOxlint } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const ruleCode = 'effect-native(no-wide-factory-signature)';
const callback = 'function* makeServices(transaction, scope, revision) { return {}; }';
const factoryTypeImport = "import type { ActionServiceFactory } from '@app/core-runtime';\n";
const effectValueImport = "import { Effect } from 'effect';\n";
const factoryFilename = 'factory.ts';
const nativeDiagnostics = (file: string) => (source: string) => {
  writeFileSync(file, source);
  return runOxlint(fixtureConfigPath('no-wide-factory-signature'), [file], appRoot).diagnostics.filter(
    ({ code }) => code === ruleCode,
  );
};

it('accepts only the genuine native transaction, scope, and revision service factory contract', () => {
  withTemporaryWorkspace((directory) => {
    const sourceDirectory = nodePath.join(directory, 'verticals', 'module');
    mkdirSync(sourceDirectory, { recursive: true });
    const file = nodePath.join(sourceDirectory, factoryFilename);
    const diagnostics = nativeDiagnostics(file);
    const imports = "import type { ActionServiceFactory } from '@app/core-runtime';\nimport { Effect } from 'effect';";

    expect(
      diagnostics(`${imports}\nconst makeNative: ActionServiceFactory<{}> = Effect.fn('native')(${callback});`),
    ).toEqual([]);
    expect(
      diagnostics(
        "import type { ActionServiceFactory as NativeFactory } from '@app/core-runtime';\n" +
          "import { Effect as Fx } from 'effect';\n" +
          `const makeNative: NativeFactory<{}> = Fx.fn('native')(${callback});`,
      ),
    ).toEqual([]);
    expect(
      diagnostics(
        `import type * as Runtime from '@app/core-runtime';\n${effectValueImport}` +
          'const makeNative: Runtime.ReadServiceFactory<{}> = (transaction, scope, revision) => Effect.succeed({});',
      ),
    ).toEqual([]);
    expect(
      diagnostics(
        "import type { ReadServiceFactory } from '@app/core-runtime';\n" +
          "import * as Fx from 'effect/Effect';\n" +
          `const makeNative: ReadServiceFactory<{}> = Fx.fnUntraced(${callback});`,
      ),
    ).toEqual([]);
    expect(
      diagnostics(
        "import type { ReadServiceFactory } from '@app/core-runtime';\n" +
          "import { fn as nativeFn } from 'effect/Effect';\n" +
          `const makeNative: ReadServiceFactory<{}> = nativeFn('native')(${callback});`,
      ),
    ).toEqual([]);

    expect(
      diagnostics(
        `import type { ActionServiceFactory } from './lookalike.ts';\n${effectValueImport}` +
          `const makeNative: ActionServiceFactory<{}> = Effect.fn('native')(${callback});`,
      ),
    ).toHaveLength(1);
    expect(
      diagnostics(
        'type ActionServiceFactory<T> = (one: unknown, two: unknown, three: unknown) => T;\n' +
          `const makeNative: ActionServiceFactory<{}> = ${callback};`,
      ),
    ).toHaveLength(1);
    expect(diagnostics(`${imports}\nconst makeNative: ActionServiceFactory<{}> = wrap(${callback});`)).toHaveLength(1);
    expect(
      diagnostics(`${imports}\nlet makeNative: ActionServiceFactory<{}> = Effect.fn('native')(${callback});`),
    ).toHaveLength(1);
    expect(
      diagnostics(
        `${imports}\nconst makeNative: ActionServiceFactory<{}> = ` +
          "Effect.fn('native')(function* makeServices(transaction, scope, revision, dependency) { return {}; });",
      ),
    ).toHaveLength(1);
  });
});

it('keeps type assertions, shadowed Effect wrappers, and surplus argument contracts conservative', () => {
  withTemporaryWorkspace((directory) => {
    const sourceDirectory = nodePath.join(directory, 'verticals', 'module');
    mkdirSync(sourceDirectory, { recursive: true });
    const file = nodePath.join(sourceDirectory, factoryFilename);
    const diagnostics = nativeDiagnostics(file);
    const imports = "import type { ActionServiceFactory } from '@app/core-runtime';\nimport { Effect } from 'effect';";
    expect(
      diagnostics(
        `${imports}\nconst makeNative: ActionServiceFactory<{}> = (${callback}) as ActionServiceFactory<{}>;`,
      ),
    ).toHaveLength(1);
    expect(
      diagnostics(
        `${imports}\nfunction configure(Effect: { fn: Function }) {\n` +
          `const makeNative: ActionServiceFactory<{}> = Effect.fn('native')(${callback});\n}`,
      ),
    ).toHaveLength(1);
    expect(
      diagnostics(
        `${factoryTypeImport}import type { Effect } from 'effect';\n` +
          `const makeNative: ActionServiceFactory<{}> = Effect.fn('native')(${callback});`,
      ),
    ).toHaveLength(1);
    expect(
      diagnostics(
        `${factoryTypeImport}import { fn as nativeFn } from './foreign-effect.ts';\n` +
          `const makeNative: ActionServiceFactory<{}> = nativeFn('native')(${callback});`,
      ),
    ).toHaveLength(1);
    expect(
      diagnostics(
        `${factoryTypeImport}import type { fn as nativeFn } from 'effect/Effect';\n` +
          `const makeNative: ActionServiceFactory<{}> = nativeFn('native')(${callback});`,
      ),
    ).toHaveLength(1);
    expect(
      diagnostics(
        `${imports}\nconst makeNative: ActionServiceFactory<{}> = ` +
          'function* makeServices(transaction, scope, ...dependencies) { return {}; };',
      ),
    ).toHaveLength(1);
  });
});

it('recognizes the native definition service argument without admitting handlers or foreign definitions', () => {
  withTemporaryWorkspace((directory) => {
    const sourceDirectory = nodePath.join(directory, 'verticals', 'module');
    mkdirSync(sourceDirectory, { recursive: true });
    const diagnostics = nativeDiagnostics(nodePath.join(sourceDirectory, factoryFilename));
    const nativeImports =
      "import { defineRead as registerRead, defineAction } from '@app/core-runtime';\nimport { Effect } from 'effect';\n";
    const directCallback = 'function makeServices(transaction, scope, revision) { return Effect.succeed({}); }';
    expect(diagnostics(`${nativeImports}registerRead({}, handler, ${directCallback}, resolver);`)).toEqual([]);
    expect(diagnostics(`${nativeImports}defineAction({}, handler, ${directCallback});`)).toEqual([]);
    expect(
      diagnostics(`${nativeImports}registerRead({}, handler, ${directCallback}, resolver, resultResolver, policies);`),
    ).toEqual([]);
    expect(diagnostics(`${nativeImports}defineAction({}, handler, ${directCallback}, decodedSuccess);`)).toEqual([]);
    expect(
      diagnostics(
        `import * as Runtime from '@app/core-runtime';\n${effectValueImport}` +
          `Runtime.defineRead({}, handler, ${directCallback}, resolver);`,
      ),
    ).toEqual([]);
    expect(
      diagnostics(`${nativeImports}registerRead({}, handler, Effect.fn('native')(${callback}), resolver);`),
    ).toEqual([]);
    expect(diagnostics(`${nativeImports}registerRead({}, ${directCallback}, serviceFactory, resolver);`)).toHaveLength(
      1,
    );
    expect(
      diagnostics(
        `import { defineRead as registerRead } from './lookalike.ts';\nregisterRead({}, handler, ${callback}, resolver);`,
      ),
    ).toHaveLength(1);
    expect(diagnostics(`${nativeImports}registerRead(...descriptors, handler, ${callback}, resolver);`)).toHaveLength(
      1,
    );
    expect(diagnostics(`${nativeImports}registerRead({}, handler, ${callback});`)).toHaveLength(1);
    expect(
      diagnostics(`${nativeImports}registerRead({}, handler, ${callback}, resolver, resultResolver, policies, extra);`),
    ).toHaveLength(1);
    expect(diagnostics(`${nativeImports}defineAction({}, handler, ${callback}, decodedSuccess, extra);`)).toHaveLength(
      1,
    );
    expect(diagnostics(`${nativeImports}registerRead({}, handler, serviceFactory, ${callback});`)).toHaveLength(1);
    expect(diagnostics(`${nativeImports}registerRead({}, handler, ${callback}, resolver, ...tail);`)).toHaveLength(1);
    expect(
      diagnostics(
        `import type { defineRead as registerRead } from '@app/core-runtime';\nregisterRead({}, handler, ${callback}, resolver);`,
      ),
    ).toHaveLength(1);
    expect(
      diagnostics(
        `import { type defineRead as registerRead } from '@app/core-runtime';\nregisterRead({}, handler, ${callback}, resolver);`,
      ),
    ).toHaveLength(1);
    expect(
      diagnostics(
        `import type * as Runtime from '@app/core-runtime';\nRuntime.defineRead({}, handler, ${callback}, resolver);`,
      ),
    ).toHaveLength(1);
  });
});
