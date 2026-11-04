import { describe } from 'effect-rstest';

import { collectCases, effectNativeRule, fixtureOptions, virtualFile, withOptions } from './rule-tester.mts';

const callback = 'function* makeServices(transaction, scope, revision) { return {}; }';
const factoryTypeImport = "import type { ActionServiceFactory } from '@app/core-runtime';\n";
const effectValueImport = "import { Effect } from 'effect';\n";
const factoryRule = 'no-wide-factory-signature';
const factoryCases = (title: string) =>
  collectCases(effectNativeRule(factoryRule), title, {
    filename: virtualFile('verticals/module/factory.ts'),
    ...withOptions(fixtureOptions(factoryRule)),
  });

describe('accepts only the genuine native transaction, scope, and revision service factory contract', () => {
  const { accept, register, reject } = factoryCases(`effect-native/${factoryRule}`);
  const imports = "import type { ActionServiceFactory } from '@app/core-runtime';\nimport { Effect } from 'effect';";

  accept(`${imports}\nconst makeNative: ActionServiceFactory<{}> = Effect.fn('native')(${callback});`);
  accept(
    "import type { ActionServiceFactory as NativeFactory } from '@app/core-runtime';\n" +
      "import { Effect as Fx } from 'effect';\n" +
      `const makeNative: NativeFactory<{}> = Fx.fn('native')(${callback});`,
  );
  accept(
    `import type * as Runtime from '@app/core-runtime';\n${effectValueImport}` +
      'const makeNative: Runtime.ReadServiceFactory<{}> = (transaction, scope, revision) => Effect.succeed({});',
  );
  accept(
    "import type { ReadServiceFactory } from '@app/core-runtime';\n" +
      "import * as Fx from 'effect/Effect';\n" +
      `const makeNative: ReadServiceFactory<{}> = Fx.fnUntraced(${callback});`,
  );
  accept(
    "import type { ReadServiceFactory } from '@app/core-runtime';\n" +
      "import { fn as nativeFn } from 'effect/Effect';\n" +
      `const makeNative: ReadServiceFactory<{}> = nativeFn('native')(${callback});`,
  );

  reject(
    1,
    `import type { ActionServiceFactory } from './lookalike.ts';\n${effectValueImport}` +
      `const makeNative: ActionServiceFactory<{}> = Effect.fn('native')(${callback});`,
  );
  reject(
    1,
    'type ActionServiceFactory<T> = (one: unknown, two: unknown, three: unknown) => T;\n' +
      `const makeNative: ActionServiceFactory<{}> = ${callback};`,
  );
  reject(1, `${imports}\nconst makeNative: ActionServiceFactory<{}> = wrap(${callback});`);
  reject(1, `${imports}\nlet makeNative: ActionServiceFactory<{}> = Effect.fn('native')(${callback});`);
  reject(
    1,
    `${imports}\nconst makeNative: ActionServiceFactory<{}> = ` +
      "Effect.fn('native')(function* makeServices(transaction, scope, revision, dependency) { return {}; });",
  );
  register();
});

describe('keeps type assertions, shadowed Effect wrappers, and surplus argument contracts conservative', () => {
  const { register, reject } = factoryCases(`effect-native/${factoryRule}`);
  const imports = "import type { ActionServiceFactory } from '@app/core-runtime';\nimport { Effect } from 'effect';";
  reject(1, `${imports}\nconst makeNative: ActionServiceFactory<{}> = (${callback}) as ActionServiceFactory<{}>;`);
  reject(
    1,
    `${imports}\nfunction configure(Effect: { fn: Function }) {\n` +
      `const makeNative: ActionServiceFactory<{}> = Effect.fn('native')(${callback});\n}`,
  );
  reject(
    1,
    `${factoryTypeImport}import type { Effect } from 'effect';\n` +
      `const makeNative: ActionServiceFactory<{}> = Effect.fn('native')(${callback});`,
  );
  reject(
    1,
    `${factoryTypeImport}import { fn as nativeFn } from './foreign-effect.ts';\n` +
      `const makeNative: ActionServiceFactory<{}> = nativeFn('native')(${callback});`,
  );
  reject(
    1,
    `${factoryTypeImport}import type { fn as nativeFn } from 'effect/Effect';\n` +
      `const makeNative: ActionServiceFactory<{}> = nativeFn('native')(${callback});`,
  );
  reject(
    1,
    `${imports}\nconst makeNative: ActionServiceFactory<{}> = ` +
      'function* makeServices(transaction, scope, ...dependencies) { return {}; };',
  );
  register();
});

describe('recognizes the native definition service argument without admitting handlers or foreign definitions', () => {
  const { accept, register, reject } = factoryCases(`effect-native/${factoryRule}`);
  const nativeImports =
    "import { defineRead as registerRead, defineAction } from '@app/core-runtime';\nimport { Effect } from 'effect';\n";
  const directCallback = 'function makeServices(transaction, scope, revision) { return Effect.succeed({}); }';
  accept(`${nativeImports}registerRead({}, handler, ${directCallback}, resolver);`);
  accept(`${nativeImports}defineAction({}, handler, ${directCallback});`);
  accept(`${nativeImports}registerRead({}, handler, ${directCallback}, resolver, resultResolver, policies);`);
  accept(`${nativeImports}defineAction({}, handler, ${directCallback}, decodedSuccess);`);
  accept(
    `import * as Runtime from '@app/core-runtime';\n${effectValueImport}` +
      `Runtime.defineRead({}, handler, ${directCallback}, resolver);`,
  );
  accept(`${nativeImports}registerRead({}, handler, Effect.fn('native')(${callback}), resolver);`);
  reject(1, `${nativeImports}registerRead({}, ${directCallback}, serviceFactory, resolver);`);
  reject(
    1,
    `import { defineRead as registerRead } from './lookalike.ts';\nregisterRead({}, handler, ${callback}, resolver);`,
  );
  reject(1, `${nativeImports}registerRead(...descriptors, handler, ${callback}, resolver);`);
  reject(1, `${nativeImports}registerRead({}, handler, ${callback});`);
  reject(1, `${nativeImports}registerRead({}, handler, ${callback}, resolver, resultResolver, policies, extra);`);
  reject(1, `${nativeImports}defineAction({}, handler, ${callback}, decodedSuccess, extra);`);
  reject(1, `${nativeImports}registerRead({}, handler, serviceFactory, ${callback});`);
  reject(1, `${nativeImports}registerRead({}, handler, ${callback}, resolver, ...tail);`);
  reject(
    1,
    `import type { defineRead as registerRead } from '@app/core-runtime';\nregisterRead({}, handler, ${callback}, resolver);`,
  );
  reject(
    1,
    `import { type defineRead as registerRead } from '@app/core-runtime';\nregisterRead({}, handler, ${callback}, resolver);`,
  );
  reject(
    1,
    `import type * as Runtime from '@app/core-runtime';\nRuntime.defineRead({}, handler, ${callback}, resolver);`,
  );
  register();
});
