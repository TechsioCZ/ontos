import { parseSync, Visitor } from 'oxc-parser';
import type { Expression, ObjectExpression, Program, Span } from 'oxc-parser';
import {
  MODULE_CONTRACT_GENERATOR_HEADER,
  MODULE_MANIFEST_IMPORT_SLOT_END,
  MODULE_MANIFEST_IMPORT_SLOT_START,
  MODULE_REGISTRATION_IMPORT_SLOT_END,
  MODULE_REGISTRATION_IMPORT_SLOT_START,
  bindSharedRuntimeWorkerEntry,
  isModuleManifestImport,
  isModuleRegistrationImport,
  raiseScaffoldFailure,
  validRuntimeDeclarationViews,
} from '../shared.mts';

type Statement = Program['body'][number];
type Member = Extract<ObjectExpression['properties'][number], { type: 'Property' }>;
type ImportStatement = Extract<Statement, { type: 'ImportDeclaration' }>;
interface Source {
  readonly comments: readonly Span[];
  readonly program: Program;
  readonly source: string;
}
interface Binding {
  readonly importText?: string;
  readonly name: string;
  readonly source: Source;
  readonly statement: Statement;
  readonly typeOnly: boolean;
}
export interface SplitRuntimeOwnerInput {
  readonly apiRoot: string;
  readonly appId: string;
  readonly manifest: string;
  readonly moduleId: string;
  readonly prefix: string;
  readonly registration: string;
}
export interface SplitRuntimeOwnerOutput {
  readonly apiRoot: string;
  readonly declaration: string;
  readonly manifest: string;
  readonly registration: string;
}

const fail = (message: string): never => raiseScaffoldFailure(`backend runtime split: ${message}`);
const span = (source: Source, node: Span): string => source.source.slice(node.start, node.end);
const parsedSource = (source: string): Source => {
  const parsed = parseSync('owner.ts', source, { astType: 'ts', lang: 'ts', sourceType: 'module' });
  if (parsed.errors.length > 0) {
    return fail('owner source must be valid TypeScript');
  }
  return { comments: parsed.comments, program: parsed.program, source };
};
const identifierNames = (source: string): Set<string> => {
  const parsed = parsedSource(source);
  const names = new Set<string>();
  new Visitor({
    Identifier: (node) => {
      names.add(node.name);
    },
  }).visit(parsed.program);
  return names;
};
const expressionNames = (source: Source, expression: Span): Set<string> =>
  identifierNames(`const splitValue = (${span(source, expression)});`);
const declarationOf = (statement: Statement) =>
  statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
const variable = (source: Source, name: string, factory: string) => {
  for (const statement of source.program.body) {
    const declaration = declarationOf(statement);
    if (declaration?.type === 'VariableDeclaration' && declaration.kind === 'const') {
      const entry = declaration.declarations.find(
        (candidate) => candidate.id.type === 'Identifier' && candidate.id.name === name,
      );
      if (entry !== undefined) {
        if (
          declaration.declarations.length !== 1 ||
          entry.init?.type !== 'CallExpression' ||
          entry.init.arguments.length !== 1
        ) {
          return fail(`${name} must have one direct factory initializer`);
        }
        const { callee } = entry.init;
        if (
          callee.type !== 'Identifier' ||
          !source.program.body.some(
            (candidate) =>
              candidate.type === 'ImportDeclaration' &&
              candidate.source.value === '@app/core-runtime' &&
              candidate.importKind !== 'type' &&
              candidate.specifiers.some(
                (specifier) =>
                  specifier.type === 'ImportSpecifier' &&
                  specifier.importKind !== 'type' &&
                  specifier.imported.type === 'Identifier' &&
                  specifier.imported.name === factory &&
                  specifier.local.name === callee.name,
              ),
          )
        ) {
          return fail(`${name} must use its genuine canonical factory`);
        }
        const [argument] = entry.init.arguments;
        if (argument?.type !== 'ObjectExpression') {
          return fail(`${name} must have an authored object initializer`);
        }
        return {
          annotation: entry.id.type === 'Identifier' ? (entry.id.typeAnnotation ?? undefined) : undefined,
          argument,
          declaration,
          statement,
        };
      }
    }
  }
  return fail(`missing canonical declaration ${name}`);
};
const memberName = (property: ObjectExpression['properties'][number]): string => {
  if (property.type !== 'Property' || property.computed || property.method || property.kind !== 'init') {
    return fail('spreads, computed keys and methods in owner objects need an explicit migration');
  }
  if (property.key.type === 'Identifier') {
    return property.key.name;
  }
  return fail('owner property has an unresolved name');
};
const members = (object: ObjectExpression): Map<string, Member> => {
  const result = new Map<string, Member>();
  for (const property of object.properties) {
    const name = memberName(property);
    if (property.type !== 'Property' || result.has(name)) {
      return fail(`duplicate owner property ${name}`);
    }
    result.set(name, property);
  }
  return result;
};
const requiredMember = (object: Map<string, Member>, name: string): Member =>
  object.get(name) ?? fail(`missing ${name}`);
const objectValue = (member: Member): ObjectExpression =>
  member.value.type === 'ObjectExpression'
    ? member.value
    : fail(`${memberName(member)} must remain an authored object`);
const declarationNames = (statement: Statement): readonly string[] => {
  const declaration = declarationOf(statement);
  if (declaration?.type === 'VariableDeclaration') {
    return declaration.declarations.map((entry) =>
      entry.id.type === 'Identifier'
        ? entry.id.name
        : fail('destructured owner declarations need an explicit migration'),
    );
  }
  if (
    declaration?.type === 'FunctionDeclaration' ||
    declaration?.type === 'ClassDeclaration' ||
    declaration?.type === 'TSTypeAliasDeclaration' ||
    declaration?.type === 'TSInterfaceDeclaration'
  ) {
    return declaration.id === null ? [] : [declaration.id.name];
  }
  return [];
};
const importBindingText = (statement: ImportStatement, index: number): string => {
  const specifier = statement.specifiers[index];
  if (specifier === undefined) {
    return fail('missing import binding');
  }
  const escapedSpecifier = statement.source.value.replaceAll('\\', String.raw`\\`).replaceAll("'", String.raw`\'`);
  const specifierPath = `'${escapedSpecifier}'`;
  const typeOnly =
    statement.importKind === 'type' || (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type');
  const type = typeOnly ? 'type ' : '';
  if (specifier.type === 'ImportDefaultSpecifier') {
    return `import ${type}${specifier.local.name} from ${specifierPath};`;
  }
  if (specifier.type === 'ImportNamespaceSpecifier') {
    return `import ${type}* as ${specifier.local.name} from ${specifierPath};`;
  }
  if (specifier.imported.type !== 'Identifier') {
    return fail('literal import names need an explicit migration');
  }
  const imported = specifier.imported.name;
  const alias = imported === specifier.local.name ? '' : ` as ${specifier.local.name}`;
  return `import ${type}{ ${imported}${alias} } from ${specifierPath};`;
};
const bindings = (sources: readonly Source[], excluded: ReadonlySet<string>): Map<string, Binding> => {
  const result = new Map<string, Binding>();
  for (const source of sources) {
    for (const statement of source.program.body) {
      if (statement.type === 'ImportDeclaration') {
        if (statement.specifiers.length === 0) {
          return fail('side-effect imports need an explicit migration');
        }
        for (const [index, specifier] of statement.specifiers.entries()) {
          const { name } = specifier.local;
          if (excluded.has(name)) {
            continue;
          }
          const importText = importBindingText(statement, index);
          const previous = result.get(name);
          if (previous !== undefined && previous.importText !== importText) {
            return fail(`conflicting import binding ${name}`);
          }
          result.set(name, {
            importText,
            name,
            source,
            statement,
            typeOnly:
              statement.importKind === 'type' ||
              (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type'),
          });
        }
      } else {
        for (const name of declarationNames(statement)) {
          if (excluded.has(name)) {
            continue;
          }
          if (result.has(name)) {
            return fail(`conflicting owner binding ${name}`);
          }
          const declaration = declarationOf(statement);
          result.set(name, {
            name,
            source,
            statement,
            typeOnly: declaration?.type === 'TSTypeAliasDeclaration' || declaration?.type === 'TSInterfaceDeclaration',
          });
        }
      }
    }
  }
  return result;
};
const dependencyClosure = (
  names: Iterable<string>,
  available: ReadonlyMap<string, Binding>,
  stop?: ReadonlySet<Statement>,
): Set<string> => {
  const result = new Set<string>();
  const visit = (name: string): void => {
    const binding = available.get(name);
    if (binding === undefined || result.has(name)) {
      return;
    }
    result.add(name);
    if (binding.importText !== undefined || stop?.has(binding.statement) === true) {
      return;
    }
    const declaration = declarationOf(binding.statement);
    if (declaration?.type === 'VariableDeclaration' && declaration.kind !== 'const') {
      return fail(`mutable backend binding ${name}`);
    }
    for (const reference of identifierNames(span(binding.source, binding.statement))) {
      visit(reference);
    }
  };
  for (const name of names) {
    visit(name);
  }
  return result;
};
const authoredComments = (source: Source, start: number, end: number): string =>
  source.comments
    .filter((comment) => comment.start >= start && comment.end <= end)
    .map((comment) => span(source, comment))
    .filter((comment) => !/^\/\/\s*(?:@generated|@ontos-|<\/?generated-)/u.test(comment))
    .join('\n');
const propertySource = (source: Source, object: ObjectExpression, property: Member): string => {
  const index = object.properties.indexOf(property);
  const previousEnd = object.properties[index - 1]?.end ?? object.start + 1;
  return [authoredComments(source, previousEnd, property.start), span(source, property)].filter(Boolean).join('\n');
};
const statementSource = (source: Source, statement: Statement, exported = false): string => {
  const previous = source.program.body[source.program.body.indexOf(statement) - 1];
  const comments = authoredComments(source, previous?.end ?? 0, statement.start);
  const code = span(source, statement);
  return [comments, exported && statement.type !== 'ExportNamedDeclaration' ? `export ${code}` : code]
    .filter(Boolean)
    .join('\n');
};
const importSection = (imports: readonly string[], kind: 'manifest' | 'registration'): string => {
  const accepts = kind === 'manifest' ? isModuleManifestImport : isModuleRegistrationImport;
  const start = kind === 'manifest' ? MODULE_MANIFEST_IMPORT_SLOT_START : MODULE_REGISTRATION_IMPORT_SLOT_START;
  const end = kind === 'manifest' ? MODULE_MANIFEST_IMPORT_SLOT_END : MODULE_REGISTRATION_IMPORT_SLOT_END;
  const inside = imports.filter((entry) => accepts(entry.replaceAll('"', "'")));
  return `${start}\n${inside.join('\n')}\n${end}`;
};
const renderImports = (imports: readonly string[], kind: 'manifest' | 'registration'): string => {
  const accepts = kind === 'manifest' ? isModuleManifestImport : isModuleRegistrationImport;
  return `${imports.filter((entry) => !accepts(entry.replaceAll('"', "'"))).join('\n')}\n${importSection(imports, kind)}`;
};
const backendImportSections = (imports: readonly string[]): string =>
  [
    ...imports.filter((entry) => !isModuleManifestImport(entry) && !isModuleRegistrationImport(entry)),
    importSection(imports, 'manifest'),
    importSection(
      imports.filter((entry) => !isModuleManifestImport(entry)),
      'registration',
    ),
  ].join('\n');

interface NamedRuntimeImport {
  readonly imported: string;
  readonly local: string;
  readonly typeOnly: boolean;
}

const groupedNamedImport = (source: Source, declarations: readonly ImportStatement[]): string => {
  const [first] = declarations;
  if (first === undefined) {
    return fail('missing named import group');
  }
  const bindingsByLocal = new Map<string, NamedRuntimeImport>();
  for (const declaration of declarations) {
    for (const specifier of declaration.specifiers) {
      if (specifier.type !== 'ImportSpecifier' || specifier.imported.type !== 'Identifier') {
        return fail('merging default or namespace imports needs an explicit migration');
      }
      const identity = {
        imported: specifier.imported.name,
        local: specifier.local.name,
        typeOnly: declaration.importKind === 'type' || specifier.importKind === 'type',
      };
      const previous = bindingsByLocal.get(identity.local);
      if (
        previous !== undefined &&
        (previous.imported !== identity.imported || previous.typeOnly !== identity.typeOnly)
      ) {
        return fail(`conflicting import identity ${identity.local}`);
      }
      bindingsByLocal.set(identity.local, identity);
    }
  }
  const identities = [...bindingsByLocal.values()];
  const typeOnly = identities.every((binding) => binding.typeOnly);
  const specifiers = identities.map((binding) => {
    const prefix = !typeOnly && binding.typeOnly ? 'type ' : '';
    const alias = binding.local === binding.imported ? '' : ` as ${binding.local}`;
    return `${prefix}${binding.imported}${alias}`;
  });
  const comments = declarations
    .map((declaration) => authoredComments(source, declaration.start, declaration.end))
    .filter(Boolean);
  return [
    ...comments,
    `import ${typeOnly ? 'type ' : ''}{ ${specifiers.join(', ')} } from ${span(source, first.source)};`,
  ].join('\n');
};

/** Merge only nongoverned imports across the whole file; owned slot imports never move. */
const mergeRuntimeImports = (content: string): string => {
  const source = parsedSource(content);
  const ownedRanges = (
    [
      [MODULE_MANIFEST_IMPORT_SLOT_START, MODULE_MANIFEST_IMPORT_SLOT_END],
      [MODULE_REGISTRATION_IMPORT_SLOT_START, MODULE_REGISTRATION_IMPORT_SLOT_END],
    ] as const
  ).map(([start, end]) => ({ end: content.indexOf(end), start: content.indexOf(start) }));
  const groups = new Map<string, ImportStatement[]>();
  for (const statement of source.program.body) {
    if (statement.type === 'ImportDeclaration') {
      groups.set(statement.source.value, [...(groups.get(statement.source.value) ?? []), statement]);
    }
  }
  const replacements: { readonly end: number; readonly start: number; readonly text: string }[] = [];
  for (const declarations of groups.values()) {
    if (declarations.length < 2) {
      continue;
    }
    if (
      declarations.some((declaration) =>
        ownedRanges.some((range) => range.start >= 0 && declaration.start > range.start && declaration.end < range.end),
      )
    ) {
      return fail('duplicate imports across governed ownership slots need an explicit migration');
    }
    const merged = groupedNamedImport(source, declarations);
    for (const [index, declaration] of declarations.entries()) {
      replacements.push({ end: declaration.end, start: declaration.start, text: index === 0 ? merged : '' });
    }
  }
  let merged = content;
  for (const replacement of replacements.toSorted((left, right) => right.start - left.start)) {
    merged = `${merged.slice(0, replacement.start)}${replacement.text}${merged.slice(replacement.end)}`;
  }
  return merged;
};

/** Changes only the import binding: every existing runtime call retains its actual local reference. */
export const bindBackendRuntimeApi = (source: string, prefix: string): string => {
  const parsed = parsedSource(source);
  const oldImports = parsed.program.body.filter(
    (statement) => statement.type === 'ImportDeclaration' && statement.source.value === '../vertical.registration.ts',
  );
  if (oldImports.length === 0) {
    const backend = parsed.program.body.some(
      (statement) =>
        statement.type === 'ImportDeclaration' &&
        statement.source.value === '../vertical.runtime-declaration.ts' &&
        statement.specifiers.some(
          (specifier) =>
            specifier.type === 'ImportSpecifier' &&
            specifier.imported.type === 'Identifier' &&
            specifier.imported.name === `${prefix}BackendRegistration`,
        ),
    );
    return backend ? source : fail('API has no genuine own registration import');
  }
  if (oldImports.length !== 1) {
    return fail('API registration import is ambiguous');
  }
  const [statement] = oldImports;
  if (statement?.type !== 'ImportDeclaration' || statement.specifiers.length !== 1) {
    return fail('API registration import must expose one owner binding');
  }
  const [specifier] = statement.specifiers;
  if (
    specifier?.type !== 'ImportSpecifier' ||
    specifier.imported.type !== 'Identifier' ||
    specifier.imported.name !== `${prefix}Registration`
  ) {
    return fail('API imports a foreign registration');
  }
  const imported = `${prefix}BackendRegistration`;
  const alias = specifier.local.name === imported ? '' : ` as ${specifier.local.name}`;
  const replacement = `import { ${imported}${alias} } from '../vertical.runtime-declaration.ts';`;
  return `${source.slice(0, statement.start)}${replacement}${source.slice(statement.end)}`;
};

/** Native worker entries without an owner-registration edge need no migration. */
export const bindBackendRuntimeWorker = (source: string, prefix: string): string => {
  const importedOwner = parsedSource(source).program.body.some(
    (statement) =>
      statement.type === 'ImportDeclaration' &&
      ['../../vertical.registration.ts', '../../vertical.runtime-declaration.ts'].includes(statement.source.value),
  );
  return importedOwner ? bindSharedRuntimeWorkerEntry(source, prefix) : source;
};

const assertDeclarativeOwner = (source: Source, ownerStatement: Statement, ownerName: string): void => {
  if (source.comments.some((comment) => /@ts-(?:ignore|expect-error|nocheck|check)\b/u.test(span(source, comment)))) {
    fail('compiler directives need an explicit migration to preserve their attachment');
  }
  for (const statement of source.program.body) {
    if (statement === ownerStatement || statement.type === 'ImportDeclaration') {
      continue;
    }
    if (
      statement.type === 'ExportNamedDeclaration' ||
      statement.type === 'ExportDefaultDeclaration' ||
      statement.type === 'ExportAllDeclaration'
    ) {
      return fail('additional authored exports need an explicit migration');
    }
    if (
      ![
        'VariableDeclaration',
        'FunctionDeclaration',
        'TSTypeAliasDeclaration',
        'TSInterfaceDeclaration',
        'EmptyStatement',
      ].includes(statement.type)
    ) {
      return fail('executable top-level statements need an explicit migration');
    }
    if (identifierNames(span(source, statement)).has(ownerName)) {
      return fail('retained declarations reference the owner before initialization');
    }
    if (statement.type === 'VariableDeclaration') {
      let functionDepth = 0;
      const functionBoundary = {
        enter: () => {
          functionDepth += 1;
        },
        exit: () => {
          functionDepth -= 1;
        },
      };
      const rejectEffect = (kind: string): void => {
        if (functionDepth === 0) {
          fail(`top-level initializer ${kind} in ${declarationNames(statement).join(', ')} need an explicit migration`);
        }
      };
      new Visitor({
        AssignmentExpression: () => rejectEffect('mutations'),
        CallExpression: () => rejectEffect('calls'),
        ImportExpression: () => rejectEffect('dynamic imports'),
        NewExpression: () => rejectEffect('constructor effects'),
        UpdateExpression: () => rejectEffect('mutations'),
        // Oxc visitors always traverse children: track deferred bodies explicitly.
        ArrowFunctionExpression: functionBoundary.enter,
        'ArrowFunctionExpression:exit': functionBoundary.exit,
        FunctionExpression: functionBoundary.enter,
        'FunctionExpression:exit': functionBoundary.exit,
      }).visit(parsedSource(span(source, statement)).program);
    }
  }
};

const assertOwnerMembers = (
  manifestMembers: Map<string, Member>,
  registrationMembers: Map<string, Member>,
  surfaceMembers: Map<string, Member>,
): void => {
  for (const key of ['module', 'activation', 'publicSurface']) {
    requiredMember(manifestMembers, key);
  }
  for (const key of ['actions', 'api', 'shellContributions']) {
    requiredMember(surfaceMembers, key);
  }
  for (const key of manifestMembers.keys()) {
    if (!['module', 'requirements', 'activation', 'publicSurface', 'originatorActions'].includes(key)) {
      return fail(`unsupported manifest field ${key}`);
    }
  }
  for (const key of registrationMembers.keys()) {
    if (!['actions', 'entrypoints', 'manifest', 'reads', 'outboxWorkers'].includes(key)) {
      return fail(`unsupported registration field ${key}`);
    }
  }
};

const actionIdentity = (expression: Expression, source: Source) =>
  span(source, expression)
    .replaceAll(/\/\*[\s\S]*?\*\//gu, '')
    .replaceAll(/\/\/[^\n]*/gu, '')
    .replaceAll(/\s/gu, '');

const assertSameOwnerInventories = (
  manifest: Source,
  registration: Source,
  manifestName: string,
  surfaceMembers: Map<string, Member>,
  registrationMembers: Map<string, Member>,
): void => {
  const registeredManifest = requiredMember(registrationMembers, 'manifest').value;
  if (
    registeredManifest.type !== 'Identifier' ||
    !registration.program.body.some(
      (statement) =>
        statement.type === 'ImportDeclaration' &&
        statement.source.value === './vertical.manifest.ts' &&
        statement.importKind !== 'type' &&
        statement.specifiers.some(
          (specifier) =>
            specifier.type === 'ImportSpecifier' &&
            specifier.importKind !== 'type' &&
            specifier.imported.type === 'Identifier' &&
            specifier.imported.name === manifestName &&
            specifier.local.name === registeredManifest.name,
        ),
    )
  ) {
    return fail('registration must reference its genuine own manifest import');
  }
  const manifestActions = requiredMember(surfaceMembers, 'actions').value;
  const registeredActions = requiredMember(registrationMembers, 'actions').value;
  if (manifestActions.type !== 'ArrayExpression' || registeredActions.type !== 'ArrayExpression') {
    return fail('Action identities require explicit owner arrays');
  }
  if (actionIdentity(manifestActions, manifest) !== actionIdentity(registeredActions, registration)) {
    return fail('manifest and runtime Action inventories differ');
  }
};

const fullImports = (source: Source, names: ReadonlySet<string>): readonly string[] =>
  source.program.body.flatMap((statement) =>
    statement.type === 'ImportDeclaration'
      ? statement.specifiers.flatMap((entry, index) =>
          names.has(entry.local.name) ? [importBindingText(statement, index)] : [],
        )
      : [],
  );

const ownerComments = (source: Source, statement: Statement): string =>
  authoredComments(source, source.program.body[source.program.body.indexOf(statement) - 1]?.end ?? 0, statement.start);

const seedInto = (node: Span, source: Source, target: Set<string>): void => {
  for (const name of expressionNames(source, node)) {
    target.add(name);
  }
};

const memberReferences = (
  source: Source,
  values: ReadonlyMap<string, Member>,
  selected: Iterable<string>,
): readonly string[] => {
  const keys = new Set(selected);
  return [...values]
    .filter(([key]) => keys.has(key))
    .flatMap(([, property]) => [...expressionNames(source, property.value)]);
};

/** Produces canonical shared metadata without evaluating any owner code or cloning private registrations. */
export const splitRuntimeOwnerSources = (input: SplitRuntimeOwnerInput): SplitRuntimeOwnerOutput => {
  const manifest = parsedSource(input.manifest);
  const registration = parsedSource(input.registration);
  const manifestName = `${input.prefix}Manifest`;
  const registrationName = `${input.prefix}Registration`;
  const runtimeManifest = `${input.prefix}RuntimeManifest`;
  const runtimeDeclaration = `${input.prefix}RuntimeDeclaration`;
  const backendRegistration = `${input.prefix}BackendRegistration`;
  const fullManifest = variable(manifest, manifestName, 'defineOntosModuleManifest');
  const fullRegistration = variable(registration, registrationName, 'defineVerticalRuntimeRegistration');
  assertDeclarativeOwner(manifest, fullManifest.statement, manifestName);
  assertDeclarativeOwner(registration, fullRegistration.statement, registrationName);
  const manifestMembers = members(fullManifest.argument);
  const registrationMembers = members(fullRegistration.argument);
  const surface = objectValue(requiredMember(manifestMembers, 'publicSurface'));
  const surfaceMembers = members(surface);
  const commonKeys = new Set(['actions', 'api', 'operationContracts', 'shellContributions']);
  assertOwnerMembers(manifestMembers, registrationMembers, surfaceMembers);
  assertSameOwnerInventories(manifest, registration, manifestName, surfaceMembers, registrationMembers);
  const sourceMap = bindings([manifest, registration], new Set([manifestName, registrationName]));
  for (const name of [runtimeManifest, runtimeDeclaration, backendRegistration, 'VerticalRuntimeRegistrationInput']) {
    if (sourceMap.has(name)) {
      return fail(`reserved shared binding ${name} already exists`);
    }
  }
  // Empty generated slots still need their authored schema helpers when later scaffolds add entries.
  const authoringHelpers = [
    'navigationContribution',
    'pageContribution',
    'publicComponentContribution',
    'reportContribution',
    'searchContribution',
  ];
  const seeds = [
    ...authoringHelpers.filter((name) => sourceMap.has(name)),
    ...memberReferences(manifest, manifestMembers, ['module', 'requirements']),
    ...memberReferences(manifest, surfaceMembers, commonKeys),
    ...memberReferences(registration, registrationMembers, ['reads', 'outboxWorkers']),
  ];
  const backendNames = dependencyClosure(seeds, sourceMap);
  const backendStatements = new Set(
    [...backendNames].flatMap((name) => {
      const entry = sourceMap.get(name);
      return entry?.importText === undefined && entry !== undefined ? [entry.statement] : [];
    }),
  );
  const frontendStatements = (source: Source, omitted: Statement) =>
    source.program.body.filter(
      (statement) =>
        statement !== omitted && statement.type !== 'ImportDeclaration' && !backendStatements.has(statement),
    );
  const manifestNames = new Set<string>();
  const registrationNames = new Set<string>();
  if (fullManifest.annotation !== undefined) {
    for (const name of identifierNames(`let value${span(manifest, fullManifest.annotation)};`)) {
      manifestNames.add(name);
    }
  }
  if (fullRegistration.annotation !== undefined) {
    for (const name of identifierNames(`let value${span(registration, fullRegistration.annotation)};`)) {
      registrationNames.add(name);
    }
  }
  const frontendSeeds = (source: Source, nodes: readonly Span[], target: Set<string>): void => {
    for (const node of nodes) {
      for (const name of identifierNames(span(source, node))) {
        target.add(name);
      }
    }
  };
  frontendSeeds(manifest, frontendStatements(manifest, fullManifest.statement), manifestNames);
  for (const [key, property] of manifestMembers) {
    if (key !== 'module' && key !== 'requirements' && key !== 'publicSurface') {
      seedInto(property.value, manifest, manifestNames);
    }
  }
  for (const [key, property] of surfaceMembers) {
    if (!commonKeys.has(key)) {
      seedInto(property.value, manifest, manifestNames);
    }
  }
  frontendSeeds(registration, frontendStatements(registration, fullRegistration.statement), registrationNames);
  const entrypoints = requiredMember(registrationMembers, 'entrypoints');
  seedInto(entrypoints.value, registration, registrationNames);
  const manifestClosure = dependencyClosure(manifestNames, sourceMap, backendStatements);
  const registrationClosure = dependencyClosure(registrationNames, sourceMap, backendStatements);
  const frontendNames = new Set([...manifestClosure, ...registrationClosure]);
  const sharedBindings = [...frontendNames]
    .map((name) => sourceMap.get(name))
    .filter((entry): entry is Binding => entry !== undefined && backendStatements.has(entry.statement));
  const backendImports = [...backendNames].flatMap((name) => sourceMap.get(name)?.importText ?? []);
  for (const entry of backendImports) {
    if (/from ["'][^"']*\/src\/(?:routes|components)\//u.test(entry)) {
      return fail('backend metadata depends on frontend implementation');
    }
  }
  const header = `${MODULE_CONTRACT_GENERATOR_HEADER}\n// @ontos-deployment-app-id ${input.appId}\n// @ontos-module-id ${input.moduleId}\n`;
  const backendPreamble = [manifest, registration]
    .flatMap((source) =>
      source.program.body
        .filter((statement) => backendStatements.has(statement))
        .map((statement) =>
          statementSource(
            source,
            statement,
            sharedBindings.some((entry) => entry.statement === statement),
          ),
        ),
    )
    .join('\n');
  const commonProperties = [...manifestMembers]
    .filter(([key]) => key === 'module' || key === 'requirements')
    .map(([, property]) => propertySource(manifest, fullManifest.argument, property));
  const surfaceProperties = [...surfaceMembers]
    .filter(([key]) => commonKeys.has(key))
    .map(([, property]) => propertySource(manifest, surface, property));
  const runtimeProperties = [...registrationMembers]
    .filter(([key]) => key === 'reads' || key === 'outboxWorkers')
    .map(([, property]) => propertySource(registration, fullRegistration.argument, property));
  const rawDeclaration = `${header}${backendImportSections(backendImports)}\nimport { defineVerticalRuntimeRegistration } from '@app/core-runtime';\nimport type { VerticalRuntimeRegistrationInput } from '@app/core-runtime';\n${backendPreamble}\nexport const ${runtimeManifest}: VerticalRuntimeRegistrationInput['manifest'] = {\n${commonProperties.join(',\n')},\npublicSurface: {\n${surfaceProperties.join(',\n')}\n},\n};\nexport const ${runtimeDeclaration}: VerticalRuntimeRegistrationInput = {\nactions: ${runtimeManifest}.publicSurface.actions,\nmanifest: ${runtimeManifest},\n${runtimeProperties.join(',\n')}\n};\nexport const ${backendRegistration} = defineVerticalRuntimeRegistration(${runtimeDeclaration});\n`;
  const remainingManifest = [...manifestMembers]
    .filter(([key]) => key !== 'module' && key !== 'requirements' && key !== 'publicSurface')
    .map(([, property]) => propertySource(manifest, fullManifest.argument, property));
  const remainingSurface = [...surfaceMembers]
    .filter(([key]) => !commonKeys.has(key))
    .map(([, property]) => propertySource(manifest, surface, property));
  const sharedImports = (names: ReadonlySet<string>) =>
    sharedBindings
      .filter((entry) => names.has(entry.name))
      .map(
        (entry) => `import ${entry.typeOnly ? 'type ' : ''}{ ${entry.name} } from './vertical.runtime-declaration.ts';`,
      )
      .join('\n');
  const preserveAuthoredComments = (source: Source, output: string): string => {
    const missing = source.comments
      .map((comment) => authoredComments(source, comment.start, comment.end))
      .filter((comment) => comment.length > 0 && !output.includes(comment));
    return missing.length === 0 ? output : `${header}${missing.join('\n')}\n${output.slice(header.length)}`;
  };
  const rawManifestView = preserveAuthoredComments(
    manifest,
    `${header}${renderImports(fullImports(manifest, manifestClosure), 'manifest')}\nimport { defineOntosModuleManifest } from '@app/core-runtime';\nimport { ${runtimeManifest} } from './vertical.runtime-declaration.ts';\n${sharedImports(manifestClosure)}\n${frontendStatements(
      manifest,
      fullManifest.statement,
    )
      .map((statement) => statementSource(manifest, statement))
      .join(
        '\n',
      )}\n${ownerComments(manifest, fullManifest.statement)}\nexport const ${manifestName}${fullManifest.annotation === undefined ? '' : span(manifest, fullManifest.annotation)} = defineOntosModuleManifest({\n...${runtimeManifest},\n${remainingManifest.join(',\n')},\npublicSurface: {\n...${runtimeManifest}.publicSurface,\n${remainingSurface.join(',\n')}\n},\n});\n`,
  );
  const rawRegistrationView = preserveAuthoredComments(
    registration,
    `${header}${fullImports(registration, registrationClosure).join('\n')}\nimport { defineVerticalRuntimeRegistration } from '@app/core-runtime';\nimport { ${manifestName} } from './vertical.manifest.ts';\nimport { ${runtimeDeclaration} } from './vertical.runtime-declaration.ts';\n${sharedImports(registrationClosure)}\n${frontendStatements(
      registration,
      fullRegistration.statement,
    )
      .map((statement) => statementSource(registration, statement))
      .join(
        '\n',
      )}\n${ownerComments(registration, fullRegistration.statement)}\nexport const ${registrationName}${fullRegistration.annotation === undefined ? '' : span(registration, fullRegistration.annotation)} = defineVerticalRuntimeRegistration({\n...${runtimeDeclaration},\n${propertySource(registration, fullRegistration.argument, entrypoints)},\nmanifest: ${manifestName},\n});\n`,
  );
  const declaration = mergeRuntimeImports(rawDeclaration);
  const manifestView = mergeRuntimeImports(rawManifestView);
  const registrationView = mergeRuntimeImports(rawRegistrationView);
  if (!validRuntimeDeclarationViews(declaration, manifestView, registrationView, input.prefix, input.moduleId)) {
    return fail('generated views do not preserve the canonical runtime declaration');
  }
  return {
    apiRoot: bindBackendRuntimeApi(input.apiRoot, input.prefix),
    declaration,
    manifest: manifestView,
    registration: registrationView,
  };
};
