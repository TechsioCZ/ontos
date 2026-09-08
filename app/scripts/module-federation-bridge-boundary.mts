import { parseSync } from 'oxc-parser';
import type { Expression, ObjectExpression, Program } from 'oxc-parser';

interface RouterDependencies {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

const property = (object: ObjectExpression, name: string): Expression | undefined => {
  // Computed keys, spreads and duplicates can overwrite an apparently literal capability.
  if (object.properties.some((entry) => entry.type === 'SpreadElement' || entry.computed)) {
    return undefined;
  }
  const entries = object.properties.filter(
    (entry) =>
      entry.type === 'Property' &&
      ((entry.key.type === 'Identifier' && entry.key.name === name) ||
        (entry.key.type === 'Literal' && entry.key.value === name)),
  );
  const entry = entries.length === 1 ? entries[0] : undefined;
  return entry?.type === 'Property' && entry.kind === 'init' && !entry.method
    ? entry.value
    : undefined;
};

const exportedConfiguration = (program: Program) => {
  const exported = program.body.find((statement) => statement.type === 'ExportDefaultDeclaration');
  let config = exported?.type === 'ExportDefaultDeclaration' ? exported.declaration : undefined;
  if (config?.type === 'Identifier') {
    const { name } = config;
    const declarations = program.body.flatMap((statement) =>
      statement.type === 'VariableDeclaration' && statement.kind === 'const'
        ? statement.declarations.filter(
            (declaration) => declaration.id.type === 'Identifier' && declaration.id.name === name,
          )
        : [],
    );
    config = declarations.length === 1 ? (declarations[0]?.init ?? undefined) : undefined;
  }
  return config;
};

/** Check the exported configuration, not an unexecuted decoy or obsolete always-on bridge rule. */
export const moduleFederationBridgeViolation = (
  source: string,
  manifest: RouterDependencies,
): string | undefined => {
  const parsed = parseSync('module-federation.config.ts', source);
  if (parsed.errors.length !== 0) {
    return 'Module Federation configuration must parse.';
  }
  const bindings = parsed.program.body.flatMap((statement) =>
    statement.type === 'ImportDeclaration' &&
    statement.importKind !== 'type' &&
    statement.source.value === '@module-federation/modern-js-v3'
      ? statement.specifiers.flatMap((specifier) =>
          specifier.type === 'ImportSpecifier' &&
          specifier.importKind !== 'type' &&
          specifier.imported.type === 'Identifier' &&
          specifier.imported.name === 'createModuleFederationConfig'
            ? [specifier.local.name]
            : [],
        )
      : [],
  );
  const config = exportedConfiguration(parsed.program);
  if (
    config?.type !== 'CallExpression' ||
    config.callee.type !== 'Identifier' ||
    !bindings.includes(config.callee.name) ||
    config.arguments.length !== 1 ||
    config.arguments[0]?.type !== 'ObjectExpression'
  ) {
    return 'Module Federation must export a literal createModuleFederationConfig call or its top-level const binding.';
  }
  const bridge = property(config.arguments[0], 'bridge');
  const enabled =
    bridge?.type === 'ObjectExpression' ? property(bridge, 'enableBridgeRouter') : undefined;
  if (enabled?.type !== 'Literal' || (enabled.value !== true && enabled.value !== false)) {
    return 'Module Federation must declare bridge.enableBridgeRouter as a boolean literal.';
  }
  if (
    enabled.value &&
    !['react-router', 'react-router-dom'].some(
      (name) =>
        Object.hasOwn(manifest.dependencies ?? {}, name) ||
        Object.hasOwn(manifest.devDependencies ?? {}, name),
    )
  ) {
    return 'Module Federation may enable the React bridge router only when the app declares react-router or react-router-dom.';
  }
  return undefined;
};
