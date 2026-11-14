import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { parseSync, Visitor } from 'oxc-parser';
import type { Expression, StringLiteral } from 'oxc-parser';

import { MODULE_CREDENTIAL_CALLERS } from '../zerops/module-credentials.mts';

const workspace = path.resolve(import.meta.dirname, '../..');
const SOURCE = /\.(?:[cm]?[jt]s|tsx)$/u;
const SKIPPED = new Set(['.output', 'dist', 'node_modules']);

const sourcesUnder = (directory: string): string[] =>
  readdirSync(path.join(workspace, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) {
      return SKIPPED.has(entry.name) || entry.name.startsWith('.') ? [] : sourcesUnder(relative);
    }
    // Hidden files are never module sources; other tests write short-lived `.api-fixture-*` files into the workspace.
    return SOURCE.test(entry.name) && !entry.name.startsWith('.') ? [relative] : [];
  });

const isTest = (file: string) => /(?:^|\/)(?:tests?|e2e)\//u.test(file) || /\.test\.[cm]?[jt]sx?$/u.test(file);
const read = (file: string) => readFileSync(path.join(workspace, file), 'utf-8');
const sources = ['apps', 'packages', 'scripts', 'verticals'].flatMap(sourcesUnder);
const production = sources.filter((file) => !isTest(file));

const parsed = (file: string) =>
  parseSync(file, read(file), { astType: 'ts', lang: file.endsWith('.tsx') ? 'tsx' : 'ts' }).program;

/** The modules a source file names: static and dynamic imports, re-exports, and `require` calls. */
const specifiersOf = (file: string) => {
  const specifiers: string[] = [];
  const named = (source: Expression | StringLiteral | null) => {
    if (source?.type === 'Literal' && Predicate.isString(source.value)) {
      specifiers.push(source.value);
    }
  };
  new Visitor({
    CallExpression: ({ arguments: [first], callee }) => {
      if (callee.type === 'Identifier' && callee.name === 'require' && first?.type === 'Literal') {
        named(first);
      }
    },
    ExportAllDeclaration: ({ source }) => named(source),
    ExportNamedDeclaration: ({ source }) => named(source),
    ImportDeclaration: ({ source }) => named(source),
    ImportExpression: ({ source }) => named(source),
  }).visit(parsed(file));
  return specifiers;
};
const importersOf = (pattern: RegExp) =>
  production.filter((file) => specifiersOf(file).some((specifier) => pattern.test(specifier)));

it('keeps the operator programs and their privileged seed writer out of every unit and the Shell', () => {
  // The agent-profile operator holds the privileged connection, and its seed writer writes with it: operator-only,
  // run from scripts, never bundled into a unit, a vertical, a package or the Shell.
  for (const pattern of [/agent-profile-operator(?:\.mts)?$/u, /agent-seed-identity(?:\.mts)?$/u]) {
    const importers = importersOf(pattern);
    expect(importers.length).toBeGreaterThan(0);
    expect(importers.filter((file) => !file.startsWith('scripts/'))).toEqual([]);
  }
});

it('lets only the delegated gateway client read an owner slot, and only the host fill one', () => {
  // The reader: a module's own credential, read by the delegated client with the calling module's app id.
  expect(importersOf(/owner-module-credential(?:\.ts)?$/u)).toEqual([
    'packages/shared-contracts/src/gateway-context-server.ts',
  ]);
  // The store: claimed and filled by the host program alone, read by the reader beside it; no package export.
  expect(importersOf(/hosted-module-credential-store(?:\.ts)?$/u)).toEqual([
    'packages/core-runtime/src/auth/owner-module-credential.ts',
    'scripts/zerops/module-credentials.mts',
  ]);
  const exported = Schema.decodeUnknownSync(
    Schema.Struct({
      exports: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)])),
    }),
  )(JSON.parse(read('packages/core-runtime/package.json'))).exports;
  expect(
    Object.values(exported).filter((target) => JSON.stringify(target).includes('hosted-module-credential-store')),
  ).toEqual([]);
});

it('lets only the host programs reach a built bundle claim, and no host load an unclaimable bundle', () => {
  // The claim export: defined by the build step, generated into each unit's entry, called by the host programs and,
  // once per unit at build time, by the claim proof (a throwaway key, in a child process of its own).
  const claimNames =
    /\b(?:ontosClaimHostedModuleCredentials|claimModuleCredentials|BUNDLE_CLAIM_EXPORT|ENTRY_CLAIM_EXPORT)\b/u;
  expect(production.filter((file) => claimNames.test(read(file))).toSorted()).toEqual([
    'scripts/demo/serve-module.mts',
    'scripts/zerops/hosted-credential-claim-proof.mts',
    'scripts/zerops/hosted-credential-claim.mts',
    'scripts/zerops/serve-units.mts',
  ]);
  expect(importersOf(/hosted-credential-claim(?:\.mts)?$/u).toSorted()).toEqual([
    'scripts/demo/serve-module.mts',
    'scripts/zerops/hosted-credential-claim-cli.mts',
    'scripts/zerops/hosted-credential-claim-proof.mts',
    'scripts/zerops/owner-entry.mts',
    'scripts/zerops/serve-units.mts',
  ]);
  // The backend federation remote carries a copy no host claims: only its build configuration names it, no runtime.
  // The gates' unit output cache names it too, only to require that a cached build still has the file; it never loads it.
  expect(
    production.filter(
      (file) =>
        read(file).includes('backendRemoteEntry') &&
        !file.endsWith('/backend-federation.config.ts') &&
        file !== 'scripts/zerops/hosted-credential-claim.mts' &&
        file !== 'scripts/ci/unit-output-cache.mts',
    ),
  ).toEqual([]);
});

it('reads the Shell gateway address under one rule, in every client that presents a key there', () => {
  // `ONTOS_SHELL_GATEWAY_BASE_URL` is read only through `shellGatewayBaseUrlConfig`: HTTPS, or plain HTTP to loopback.
  const ownRule = /Config\.[A-Za-z]+\([^;]*?'ONTOS_SHELL_GATEWAY_BASE_URL'/su;
  expect(production.filter((file) => ownRule.test(read(file))).toSorted()).toEqual([
    'packages/shared-contracts/src/shell-gateway-url.ts',
  ]);
});

/** A string constant: a literal, or one cast `as const`. */
const literalOf = (node: Expression | null): string | undefined => {
  if (node === null) {
    return undefined;
  }
  if (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression') {
    return literalOf(node.expression);
  }
  return node.type === 'Literal' && Predicate.isString(node.value) ? node.value : undefined;
};

/** Every `callingAppId` a source file passes, resolved to its string; a value it cannot resolve is `undefined`. */
const callingAppIdsOf = (file: string) => {
  if (!read(file).includes('callingAppId')) {
    return [];
  }
  const constants = new Map<string, string>();
  const passed: Expression[] = [];
  const program = parsed(file);
  new Visitor({
    ObjectExpression: ({ properties }) => {
      for (const property of properties) {
        if (
          property.type === 'Property' &&
          !property.computed &&
          property.key.type === 'Identifier' &&
          property.key.name === 'callingAppId'
        ) {
          passed.push(property.value);
        }
      }
    },
    VariableDeclarator: ({ id, init }) => {
      const value = literalOf(init);
      if (id.type === 'Identifier' && value !== undefined) {
        constants.set(id.name, value);
      }
    },
  }).visit(program);
  return passed.map((value) => ({
    file,
    value: literalOf(value) ?? (value.type === 'Identifier' ? constants.get(value.name) : undefined),
  }));
};

const TopologySchema = Schema.Struct({
  verticals: Schema.Array(Schema.Struct({ id: Schema.String, path: Schema.String })),
});
const { verticals } = Schema.decodeUnknownSync(TopologySchema)(JSON.parse(read('topology/reference-topology.json')));
const byName = (left: string | undefined, right: string | undefined) => String(left).localeCompare(String(right));

it("makes every module call the gateway as its own topology app id, never as another module's", () => {
  const calls = production
    .filter((file) => file.startsWith('verticals/') || file.startsWith('apps/'))
    .flatMap(callingAppIdsOf);
  const misnamed = calls.flatMap((call) => {
    const owner = verticals.find((vertical) => call.file.startsWith(`${vertical.path}/`));
    return owner !== undefined && call.value === owner.id ? [] : [{ ...call, owner: owner?.id }];
  });
  // A value is a string literal or a same-file constant equal to the owning vertical's topology id; the Shell and
  // anything outside a vertical never names a calling module.
  expect(misnamed).toEqual([]);
  // Every module that calls has a platform-issued key, and every module issued a key calls.
  expect([...new Set(calls.map(({ value }) => value))].toSorted(byName)).toEqual(
    MODULE_CREDENTIAL_CALLERS.toSorted(byName),
  );
});
