import { readFile } from 'node:fs/promises';
import nodePath from 'node:path';

import { Effect, Path } from 'effect';
import { expect, it } from 'effect-rstest';
import { parseSync } from 'oxc-parser';

import { provesScopedCoreBooleanFact } from '../scoped-core-fact-proof.mts';

const nativePredicateImport = "import { Predicate } from 'effect';";
const nativeEffectImport = "import { Effect, Predicate } from 'effect';";
const allowedDecisionBranch = "  if (decision.outcome === 'ALLOWED') {";
const admissionAttachment = 'Object.defineProperty(carrier, scopeProperty,';
const originalBooleanResult = 'Effect.succeed(workloadKeys.has(workloadKey))';
const directory = 'packages/core-runtime/src/access/enforcement';
const admissionFile = `${directory}/workload-admission.ts`;
const selectionFile = `${directory}/selected-workload-decision-seal.ts`;
const fixture = Effect.gen(function* actualCoreSources() {
  const root = nodePath.resolve(import.meta.dirname, '../..');
  const sources = new Map<string, string>();
  for (const relative of [admissionFile, selectionFile]) {
    const file = nodePath.join(root, relative);
    sources.set(file, yield* Effect.tryPromise(() => readFile(file, 'utf-8')));
  }
  return { root, sources };
});
const prove = (root: string, sources: ReadonlyMap<string, string>) =>
  Effect.gen(function* proveActualCoreFact() {
    const path = yield* Path.Path;
    const file = nodePath.join(root, admissionFile);
    const source = sources.get(file) ?? '';
    const parsed = parseSync(file, source);
    expect(parsed.errors).toEqual([]);
    const exported = parsed.program.body.find(
      (node) =>
        node.type === 'ExportNamedDeclaration' &&
        node.declaration?.type === 'VariableDeclaration' &&
        node.declaration.declarations.some(
          (declaration) => declaration.id.type === 'Identifier' && declaration.id.name === 'readScopedAdmittedWorkload',
        ),
    );
    const [binding] =
      exported?.type === 'ExportNamedDeclaration' && exported.declaration?.type === 'VariableDeclaration'
        ? exported.declaration.declarations
        : [];
    return binding?.init === null || binding?.init === undefined
      ? false
      : provesScopedCoreBooleanFact(sources, root, path, new Map(), file, binding.init);
  }).pipe(Effect.provide(Path.layer));

it.effect('proves the actual constructor-fed native Set boolean fact', () =>
  Effect.gen(function* actualBooleanFact() {
    const { root, sources } = yield* fixture;
    expect(yield* prove(root, sources)).toBe(true);
  }),
);

it.effect('tracks renamed private fields and immutable selected collection bindings', () =>
  Effect.gen(function* renamedPrivateCollection() {
    const { root, sources } = yield* fixture;
    const renamed = new Map(
      [...sources].map(([file, source]) => [file, source.replaceAll('workloadKeys', 'nativeKeys')]),
    );
    expect(yield* prove(root, renamed)).toBe(true);
  }),
);

it.effect.each([
  {
    file: admissionFile,
    from: originalBooleanResult,
    name: 'raw Set projection',
    to: 'Effect.succeed(workloadKeys)',
  },
  {
    file: admissionFile,
    from: originalBooleanResult,
    name: 'raw transaction projection',
    to: 'Effect.succeed(transaction)',
  },
  {
    file: admissionFile,
    from: originalBooleanResult,
    name: 'extra executor output',
    to: 'Effect.succeed({ admitted: workloadKeys.has(workloadKey), executor: transaction })',
  },
  {
    file: admissionFile,
    from: 'workloadKeys.has(workloadKey)',
    name: 'unknown boolean method',
    to: 'workloadKeys.customHas(workloadKey)',
  },
  {
    file: admissionFile,
    from: 'workloadKeys.has(workloadKey)',
    name: 'indirect method call',
    to: 'workloadKeys.has.call(workloadKeys, workloadKey)',
  },
  { file: admissionFile, from: '? seal.#workloadKeys', name: 'private transaction getter', to: '? seal.#transaction' },
  {
    file: admissionFile,
    from: 'new ScopedWorkloadAdmissionSeal(carrier, input.scope, workloadKeys,',
    name: 'tainted constructor argument',
    to: 'new ScopedWorkloadAdmissionSeal(carrier, input.scope, transaction,',
  },
  {
    file: admissionFile,
    from: 'selected.workloadKeys : new Set<string>()',
    name: 'unconstructed collection fallback',
    to: 'selected.workloadKeys : unknownSet',
  },
  {
    file: selectionFile,
    from: 'workloadKeys: new Set(workloadKeys)',
    name: 'interface-only upstream collection',
    to: 'workloadKeys',
  },
  {
    file: selectionFile,
    from: 'new Set(workloadKeys)',
    name: 'custom upstream Set constructor',
    to: 'new CustomSet(workloadKeys)',
  },
  {
    file: selectionFile,
    from: nativePredicateImport,
    name: 'native Set method mutation',
    to: "import { Predicate } from 'effect';\nSet.prototype.has = customHas;",
  },
  {
    file: selectionFile,
    from: nativePredicateImport,
    name: 'native Set namespace alias',
    to: "import { Predicate } from 'effect';\nconst NativeSet = Set; NativeSet.prototype.has = customHas;",
  },
  {
    file: admissionFile,
    from: 'this.#workloadKeys = workloadKeys;',
    name: 'constructor receiver mutation',
    to: 'this.#workloadKeys = workloadKeys;\nworkloadKeys.has = customHas;',
  },
  {
    file: selectionFile,
    from: '? seal.#selected : undefined',
    name: 'wrong upstream private field',
    to: '? seal.#decision : undefined',
  },
  {
    file: selectionFile,
    from: 'seal.#decision === decision',
    name: 'wrong original decision identity',
    to: 'seal.#decision === otherDecision',
  },
  {
    file: admissionFile,
    from: admissionAttachment,
    name: 'wrong property attachment target',
    to: 'Object.defineProperty(otherCarrier, scopeProperty,',
  },
  {
    file: admissionFile,
    from: 'Predicate.isObject(seal)',
    name: 'unknown seal predicate',
    to: 'unknownPredicate(seal)',
  },
  { file: admissionFile, from: "from 'effect'", name: 'fake Effect namespace import', to: "from 'fake-effect'" },
  { file: selectionFile, from: "from 'effect'", name: 'fake upstream Predicate import', to: "from 'fake-effect'" },
  {
    file: admissionFile,
    from: 'ScopedWorkloadAdmissionSeal.read(transaction, scope)',
    name: 'unknown getter callee',
    to: 'ScopedWorkloadAdmissionSeal.otherRead(transaction, scope)',
  },
  {
    file: selectionFile,
    from: 'export const readSelectedWorkloadDecision',
    name: 'mutable upstream reader',
    to: 'export let readSelectedWorkloadDecision',
  },
  {
    file: admissionFile,
    from: '  const carrier = { ...transaction };',
    name: 'selected collection instance escape',
    to: '  mutate(selected.workloadKeys);\n  const carrier = { ...transaction };',
  },
  {
    file: selectionFile,
    from: 'seal.#decision === decision',
    name: 'getter mutation call',
    to: 'seal.#decision === decision && mutate(seal.#selected)',
  },
  {
    file: admissionFile,
    from: admissionAttachment,
    name: 'multiple admission providers',
    to: 'new ScopedWorkloadAdmissionSeal(carrier, input.scope, workloadKeys, input.actionInvocationId);\nObject.defineProperty(carrier, scopeProperty,',
  },
  {
    file: admissionFile,
    from: 'class ScopedWorkloadAdmissionSeal {',
    name: 'exported private constructor',
    to: 'export class ScopedWorkloadAdmissionSeal {',
  },
  {
    file: admissionFile,
    from: '/** Core-private: binds',
    name: 'bound private constructor',
    to: 'const BoundSeal = ScopedWorkloadAdmissionSeal.bind(null);\n/** Core-private: binds',
  },
  {
    file: admissionFile,
    from: '  close(): void {',
    name: 'static constructor escape',
    to: '  static constructorValue() { return this; }\n  close(): void {',
  },
  {
    file: selectionFile,
    from: nativePredicateImport,
    name: 'ambient native Set mutation',
    to: "import { Predicate } from 'effect';\nglobalThis.Set.prototype.has = customHas;",
  },
  {
    file: selectionFile,
    from: nativePredicateImport,
    name: 'ambient global alias mutation',
    to: "import { Predicate } from 'effect';\nconst ambient = globalThis; ambient.Set.prototype.has = customHas;",
  },
  {
    file: selectionFile,
    from: nativePredicateImport,
    name: 'Reflect native Set mutation',
    to: "import { Predicate } from 'effect';\nReflect.set(Set.prototype, 'has', customHas);",
  },
  {
    file: selectionFile,
    from: nativePredicateImport,
    name: 'ambient Object mutation',
    to: "import { Predicate } from 'effect';\nglobalThis.Object.freeze = customFreeze;",
  },
  {
    file: admissionFile,
    from: nativeEffectImport,
    name: 'alternate named Effect mutation',
    to: "import { Effect, Predicate } from 'effect';\nimport { Effect as Fx } from 'effect'; Fx.succeed = customSucceed;",
  },
  {
    file: admissionFile,
    from: nativeEffectImport,
    name: 'namespace Effect mutation',
    to: "import { Effect, Predicate } from 'effect';\nimport * as fx from 'effect'; fx.Effect.succeed = customSucceed;",
  },
  {
    file: admissionFile,
    from: nativeEffectImport,
    name: 'dynamic Effect mutation',
    to: "import { Effect, Predicate } from 'effect';\n(await import('effect')).Effect.succeed = customSucceed;",
  },
  {
    file: selectionFile,
    from: allowedDecisionBranch,
    name: 'hoisted native Set shadow',
    to: "  if (false) { var Set = CustomSet; }\n  if (decision.outcome === 'ALLOWED') {",
  },
  {
    file: selectionFile,
    from: allowedDecisionBranch,
    name: 'hoisted native Object shadow',
    to: "  if (false) { var Object = CustomObject; }\n  if (decision.outcome === 'ALLOWED') {",
  },
  {
    file: selectionFile,
    from: allowedDecisionBranch,
    name: 'catch native Set shadow',
    to: '  try { throw 1; } catch (Set) {',
  },
  {
    file: selectionFile,
    from: nativePredicateImport,
    name: 'cross-model Effect alias mutation',
    to: "import { Predicate } from 'effect';\nimport { Effect as Fx } from 'effect'; Fx.succeed = customSucceed;",
  },
  {
    file: admissionFile,
    from: admissionAttachment,
    name: 'instance constructor escape',
    to: 'const Ctor = admission.constructor; new Ctor(carrier, input.scope, unknownSet);\nObject.defineProperty(carrier, scopeProperty,',
  },
  {
    file: admissionFile,
    from: admissionAttachment,
    name: 'prototype constructor escape',
    to: 'const Ctor = Object.getPrototypeOf(admission).constructor; new Ctor(carrier, input.scope, unknownSet);\nObject.defineProperty(carrier, scopeProperty,',
  },
  {
    file: admissionFile,
    from: '  const carrier = { ...transaction };',
    name: 'producer transaction stash',
    to: '  stash(transaction);\n  const carrier = { ...transaction };',
  },
  {
    file: selectionFile,
    from: allowedDecisionBranch,
    name: 'upstream provider mutation call',
    to: "  mutateNativeCollections();\n  if (decision.outcome === 'ALLOWED') {",
  },
  {
    file: selectionFile,
    from: 'Predicate.isObject(seal) &&',
    name: 'exhausted finite seal proof depth',
    to: 'Predicate.isObject(seal) && '.repeat(70),
  },
])('rejects $name', ({ file, from, to }) =>
  Effect.gen(function* invalidBooleanFact() {
    const { root, sources } = yield* fixture;
    const target = nodePath.join(root, file);
    const source = sources.get(target) ?? '';
    expect(source).toContain(from);
    const changed = source.replaceAll(from, to);
    expect(parseSync(target, changed).errors).toEqual([]);
    sources.set(target, changed);
    expect(yield* prove(root, sources)).toBe(false);
  }),
);

it.effect('rejects another runtime consumer of the selected private record', () =>
  Effect.gen(function* escapedSelectedRecord() {
    const { root, sources } = yield* fixture;
    sources.set(
      nodePath.join(root, directory, 'unrelated.ts'),
      "import { readSelectedWorkloadDecision } from './selected-workload-decision-seal.ts';\nexport const escape = decision => readSelectedWorkloadDecision(decision);",
    );
    expect(yield* prove(root, sources)).toBe(false);
  }),
);

it.effect('rejects a named function expression shadowing the native constructor', () =>
  Effect.gen(function* namedSetFunction() {
    const { root, sources } = yield* fixture;
    const file = nodePath.join(root, selectionFile);
    const original = sources.get(file) ?? '';
    const changed = original
      .replace(
        'export const sealSelectedWorkloadDecision = (',
        'export const sealSelectedWorkloadDecision = function Set(',
      )
      .replace('): AccessDecision => {', '): AccessDecision {');
    expect(parseSync(file, changed).errors).toEqual([]);
    sources.set(file, changed);
    expect(yield* prove(root, sources)).toBe(false);
  }),
);

it.effect('rejects a failure containing an outer transaction alias', () =>
  Effect.gen(function* failureAlias() {
    const { root, sources } = yield* fixture;
    const file = nodePath.join(root, admissionFile);
    const original = sources.get(file) ?? '';
    const changed = original
      .replace(') =>\n  Effect.suspend(() => {', ') => { const saved = transaction; return Effect.suspend(() => {')
      .replace(
        "accessDecisionUnavailable('The selected workload branch is unavailable outside its exact owner scope')",
        'saved',
      )
      .replace(
        '    return Effect.succeed(workloadKeys.has(workloadKey));\n  });',
        '    return Effect.succeed(workloadKeys.has(workloadKey));\n  }); };',
      );
    expect(parseSync(file, changed).errors).toEqual([]);
    sources.set(file, changed);
    expect(yield* prove(root, sources)).toBe(false);
  }),
);

it.effect.each([
  {
    consumer:
      "import { aliasReader } from './selected-workload-decision-seal.ts'; export const escape = decision => aliasReader(decision);",
    extra: 'export { readSelectedWorkloadDecision as aliasReader };',
    name: 'reader alias export',
  },
  { consumer: "export * from './selected-workload-decision-seal.ts';", extra: '', name: 'star barrel export' },
  {
    consumer: "export const escape = import('./selected-workload-decision-seal.ts');",
    extra: '',
    name: 'dynamic reader module',
  },
  {
    consumer: 'export const escape = import(`./selected-workload-decision-seal.ts`);',
    extra: '',
    name: 'template reader module',
  },
  {
    consumer: "export const escape = import('./selected-workload-' + 'decision-seal.ts');",
    extra: '',
    name: 'concatenated reader module',
  },
  {
    consumer: 'export const escape = (file: string) => import(file);',
    extra: '',
    name: 'unknown Core dynamic reader module',
  },
])('rejects $name custody escape', ({ consumer, extra }) =>
  Effect.gen(function* selectedReaderEscape() {
    const { root, sources } = yield* fixture;
    const file = nodePath.join(root, selectionFile);
    sources.set(file, (sources.get(file) ?? '') + extra);
    sources.set(nodePath.join(root, directory, 'unrelated.ts'), consumer);
    expect(yield* prove(root, sources)).toBe(false);
  }),
);
