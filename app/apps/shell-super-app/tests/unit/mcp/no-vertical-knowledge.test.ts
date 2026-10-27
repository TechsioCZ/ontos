// @rstest-environment node
/**
 * Core and the Shell platform must not know any MicroVertical: every vertical id, module id, tool name, label,
 * navigation entry, review rule or follow-up comes from the composed module contracts. This test fails when a
 * vertical id appears in that source as a quoted literal or a path segment, or a module id appears anywhere.
 * Companies are tenant data too: the Shell UI must not name a demo company or key behaviour by its legal entity id.
 * Allowed exceptions: demo guide content and seed data (tenant data, not platform behaviour), and the published
 * identity descriptor import in the Shell's exact database enrollment composition root.
 */
import { OntosDeploymentAppIdSchema, OntosModuleIdSchema } from '@app/core-runtime';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  akrosDemoCompany,
  commercialDemoCompany,
  crmDemoCompany,
  eshopDemoCompany,
  rentalDemoCompany,
} from '@app/core-runtime/demo-company-profiles';
import { expect, it } from 'effect-rstest';
import { Schema } from 'effect';
import { parseSync } from 'oxc-parser';

const appRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const verticalsRoot = path.join(appRoot, 'verticals');

/** All of Core and the Shell server and UI. */
const GUARDED = [
  'packages/core-runtime/src',
  'packages/shared-contracts/src',
  'apps/shell-super-app/api',
  'apps/shell-super-app/server',
  'apps/shell-super-app/shared',
  'apps/shell-super-app/src',
  'scripts/ontos-mcp-contribution.mts',
];

/** Demo guide content and seed data (`demo-seed/` directories) name the demo tenants' modules on purpose. */
const EXCEPTIONS = ['apps/shell-super-app/src/demo-guide/guides/'];
const SEED_DIRECTORY = `${path.sep}demo-seed${path.sep}`;

const VerticalManifestSchema = Schema.fromJsonString(
  Schema.Struct({
    modernjs: Schema.optionalKey(
      Schema.Struct({
        appId: Schema.optionalKey(OntosDeploymentAppIdSchema),
        ontosModule: Schema.optionalKey(Schema.Struct({ moduleId: Schema.optionalKey(OntosModuleIdSchema) })),
      }),
    ),
  }),
);

const verticals = readdirSync(verticalsRoot).flatMap((directory) => {
  try {
    const manifest = Schema.decodeUnknownSync(VerticalManifestSchema)(
      readFileSync(path.join(verticalsRoot, directory, 'package.json'), 'utf-8'),
    );
    return [
      {
        appId: manifest.modernjs?.appId ?? directory,
        moduleId: manifest.modernjs?.ontosModule?.moduleId,
      },
    ];
  } catch {
    return [];
  }
});

const escapeRegex = (value: string): string => value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

const patterns = verticals.flatMap(({ appId, moduleId }) => [
  { id: appId, pattern: new RegExp(`['"\`/]${escapeRegex(appId)}['"\`/]`, 'u') },
  ...(moduleId === undefined ? [] : [{ id: moduleId, pattern: new RegExp(escapeRegex(moduleId), 'u') }]),
]);

const ENROLLMENT_ROOT = 'apps/shell-super-app/api/database-identity-enrollment.ts';
const ENROLLMENT_DESCRIPTOR_IMPORT =
  "import { PARTY_REGISTRY_DATABASE_IDENTITY_DESCRIPTOR } from '@app/party-registry/database-identities';";

/** Only this named public contract import is composition metadata, not private vertical knowledge. */
const withoutEnrollmentImportSource = (file: string, source: string): string => {
  if (file !== ENROLLMENT_ROOT) {
    return source;
  }
  const parsed = parseSync(file, source);
  if (parsed.errors.length > 0) {
    return source;
  }
  const sources = parsed.program.body.flatMap((statement) => {
    if (
      statement.type !== 'ImportDeclaration' ||
      statement.importKind !== 'value' ||
      statement.phase !== null ||
      statement.attributes.length !== 0 ||
      statement.source.value !== '@app/party-registry/database-identities' ||
      statement.specifiers.length !== 1
    ) {
      return [];
    }
    const [specifier] = statement.specifiers;
    return specifier?.type === 'ImportSpecifier' &&
      specifier.importKind === 'value' &&
      specifier.imported.type === 'Identifier' &&
      specifier.imported.name === 'PARTY_REGISTRY_DATABASE_IDENTITY_DESCRIPTOR'
      ? [statement.source]
      : [];
  });
  // Mask only the source literal, not the import's line or the file. Keep every line number intact.
  return sources.reduceRight(
    (text, { end, start }) =>
      text.slice(0, start) + text.slice(start, end).replaceAll(/[^\r\n]/gu, ' ') + text.slice(end),
    source,
  );
};

const verticalKnowledgeIn = (file: string, source: string): string[] =>
  withoutEnrollmentImportSource(file, source)
    .split('\n')
    .flatMap((line, index) =>
      patterns.filter(({ pattern }) => pattern.test(line)).map(({ id }) => `${file}:${index + 1} names ${id}`),
    );

const isException = (file: string): boolean => {
  const relative = path.relative(appRoot, file);
  return file.includes(SEED_DIRECTORY) || EXCEPTIONS.some((exception) => relative.startsWith(exception));
};

const filesOf = (relative: string): string[] => {
  const absolute = path.join(appRoot, relative);
  if (statSync(absolute).isFile()) {
    return [absolute];
  }
  return readdirSync(absolute, { recursive: true })
    .map((entry) => path.join(absolute, String(entry)))
    .filter(
      (file) =>
        /\.(?:mts|ts|tsx)$/u.test(file) &&
        !file.includes(`${path.sep}node_modules${path.sep}`) &&
        statSync(file).isFile(),
    )
    .filter((file) => !isException(file));
};

/** The Shell UI, where company knowledge crept in as id-suffix maps and company texts. */
const COMPANY_GUARDED = ['apps/shell-super-app/src'];
const companies = [akrosDemoCompany, commercialDemoCompany, crmDemoCompany, eshopDemoCompany, rentalDemoCompany];
/** The name without its legal form, e.g. `Velkoobchod Hanák` for `Velkoobchod Hanák s.r.o.`. */
const baseName = (legalName: string): string => legalName.replace(/\s+(?:s\.r\.o\.|a\.s\.|\(demo\))$/u, '');
const companyPatterns = companies.flatMap(({ legalEntityId, legalName }) => {
  const significant = (legalEntityId.split('-').at(-1) ?? '').replace(/^0+/u, '');
  return [
    { id: legalEntityId, pattern: new RegExp(escapeRegex(legalEntityId), 'u') },
    // A quoted suffix of the id, e.g. `'020'`, used to key company behaviour without naming the full id.
    { id: `${legalEntityId} suffix`, pattern: new RegExp(`['"\`]0+${escapeRegex(significant)}['"\`]`, 'u') },
    {
      id: legalName,
      pattern: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(baseName(legalName))}(?![\\p{L}\\p{N}])`, 'u'),
    },
  ];
});

it('keeps runtime browser imports out of server implementation modules', () => {
  const apiRoot = path.join(appRoot, 'apps/shell-super-app/api');
  const hits = filesOf('apps/shell-super-app/src').flatMap((file) =>
    parseSync(file, readFileSync(file, 'utf-8')).program.body.flatMap((statement) => {
      if (
        statement.type !== 'ImportDeclaration' ||
        statement.importKind === 'type' ||
        !statement.source.value.startsWith('.') ||
        (statement.specifiers.length > 0 &&
          statement.specifiers.every(
            (specifier) => specifier.type === 'ImportSpecifier' && specifier.importKind === 'type',
          ))
      ) {
        return [];
      }
      const target = path.resolve(path.dirname(file), statement.source.value);
      return target.startsWith(`${apiRoot}${path.sep}`) && target !== path.join(apiRoot, 'index.ts')
        ? [`${path.relative(appRoot, file)} imports ${path.relative(appRoot, target)}`]
        : [];
    }),
  );
  expect(hits).toEqual([]);
});

it('finds the verticals of this workspace', () => {
  expect(verticals.length).toBeGreaterThan(5);
});

it('allows the published descriptor at the native Shell enrollment composition root', () => {
  const source = [
    "import { defineDatabaseIdentityEnrollment } from '@app/core-runtime/db/database-identity-manifest';",
    ENROLLMENT_DESCRIPTOR_IMPORT,
    'export const SHELL_DATABASE_IDENTITY_ENROLLMENT = defineDatabaseIdentityEnrollment([',
    '  PARTY_REGISTRY_DATABASE_IDENTITY_DESCRIPTOR,',
    ']);',
  ].join('\n');
  expect(verticalKnowledgeIn(ENROLLMENT_ROOT, source)).toEqual([]);
});

it('recognizes a multiline named descriptor import by its imported contract, not its local alias', () => {
  const source = [
    'import {',
    '  PARTY_REGISTRY_DATABASE_IDENTITY_DESCRIPTOR as ownerIdentity,',
    "} from '@app/party-registry/database-identities';",
  ].join('\n');
  expect(verticalKnowledgeIn(ENROLLMENT_ROOT, source)).toEqual([]);
});

const rejectedEnrollmentImports = [
  {
    file: 'apps/shell-super-app/api/mcp/index.ts',
    name: 'the same published descriptor in runtime code outside the composition root',
    source: ENROLLMENT_DESCRIPTOR_IMPORT,
  },
  {
    file: 'apps/shell-super-app/api/mcp/database-identity-enrollment.ts',
    name: 'an enrollment filename in another directory',
    source: ENROLLMENT_DESCRIPTOR_IMPORT,
  },
  {
    file: ENROLLMENT_ROOT,
    name: 'a private vertical implementation import at the composition root',
    source: "import { schema } from '@app/party-registry/src/db/schema.ts';",
  },
  {
    file: ENROLLMENT_ROOT,
    name: 'a relative private vertical implementation import',
    source: "import { schema } from '../../../verticals/party-registry/src/db/schema.ts';",
  },
  {
    file: ENROLLMENT_ROOT,
    name: 'a runtime export from the published descriptor subpath',
    source: "import { makePartyRuntime } from '@app/party-registry/database-identities';",
  },
  {
    file: ENROLLMENT_ROOT,
    name: 'a descriptor mixed with another export',
    source:
      "import { PARTY_REGISTRY_DATABASE_IDENTITY_DESCRIPTOR, PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT } from '@app/party-registry/database-identities';",
  },
  {
    file: ENROLLMENT_ROOT,
    name: 'a namespace import',
    source: "import * as identities from '@app/party-registry/database-identities';",
  },
  {
    file: ENROLLMENT_ROOT,
    name: 'a default import',
    source: "import descriptor from '@app/party-registry/database-identities';",
  },
  {
    file: ENROLLMENT_ROOT,
    name: 'a side-effect import',
    source: "import '@app/party-registry/database-identities';",
  },
  {
    file: ENROLLMENT_ROOT,
    name: 'a type-only import',
    source:
      "import type { PARTY_REGISTRY_DATABASE_IDENTITY_DESCRIPTOR } from '@app/party-registry/database-identities';",
  },
  {
    file: ENROLLMENT_ROOT,
    name: 'a dynamic import',
    source: "const load = () => import('@app/party-registry/database-identities');",
  },
  {
    file: ENROLLMENT_ROOT,
    name: 'a re-export',
    source: "export { PARTY_REGISTRY_DATABASE_IDENTITY_DESCRIPTOR } from '@app/party-registry/database-identities';",
  },
  {
    file: ENROLLMENT_ROOT,
    name: 'a require call',
    source: "const descriptor = require('@app/party-registry/database-identities');",
  },
  {
    file: ENROLLMENT_ROOT,
    name: 'a quoted path outside an import',
    source: "const descriptorPath = '@app/party-registry/database-identities';",
  },
  {
    file: ENROLLMENT_ROOT,
    name: 'an import-shaped comment',
    source: `// ${ENROLLMENT_DESCRIPTOR_IMPORT}`,
  },
  {
    file: ENROLLMENT_ROOT,
    name: 'an attributed import rather than the native descriptor import',
    source: ENROLLMENT_DESCRIPTOR_IMPORT.replace(';', ' with { type: "json" };'),
  },
  {
    file: ENROLLMENT_ROOT,
    name: 'an otherwise permitted import in an invalid program',
    source: `${ENROLLMENT_DESCRIPTOR_IMPORT}\nconst broken = ;`,
  },
];

for (const { file, name, source } of rejectedEnrollmentImports) {
  it(`still rejects ${name}`, () => {
    expect(verticalKnowledgeIn(file, source)).toEqual([`${file}:1 names party-registry`]);
  });
}

it('still rejects a private import on the same line as the permitted descriptor import', () => {
  const source = `${ENROLLMENT_DESCRIPTOR_IMPORT} import { schema } from '@app/party-registry/src/db/schema.ts';`;
  expect(verticalKnowledgeIn(ENROLLMENT_ROOT, source)).toEqual([`${ENROLLMENT_ROOT}:1 names party-registry`]);
});

it('still scans runtime literals and module ids after the permitted import without changing line numbers', () => {
  const source = `${ENROLLMENT_DESCRIPTOR_IMPORT}\nconst audience = 'party-registry';\nconst moduleId = 'party.registry';`;
  expect(verticalKnowledgeIn(ENROLLMENT_ROOT, source)).toEqual([
    `${ENROLLMENT_ROOT}:2 names party-registry`,
    `${ENROLLMENT_ROOT}:3 names party.registry`,
  ]);
});

it('does not permit another vertical descriptor at the enrollment root', () => {
  const source = "import { INVENTORY_DATABASE_IDENTITY_DESCRIPTOR } from '@app/inventory/database-identities';";
  expect(verticalKnowledgeIn(ENROLLMENT_ROOT, source)).toEqual([`${ENROLLMENT_ROOT}:1 names inventory`]);
});

it('keeps Core and the whole Shell platform free of vertical ids', () => {
  const hits = GUARDED.flatMap(filesOf).flatMap((file) =>
    verticalKnowledgeIn(path.relative(appRoot, file), readFileSync(file, 'utf-8')),
  );
  expect(hits).toEqual([]);
});

it('keeps the Shell UI free of demo company ids and names', () => {
  expect(companyPatterns.length).toBe(companies.length * 3);
  const hits = COMPANY_GUARDED.flatMap(filesOf).flatMap((file) => {
    const lines = readFileSync(file, 'utf-8').split('\n');
    return lines.flatMap((line, index) =>
      companyPatterns
        .filter(({ pattern }) => pattern.test(line))
        .map(({ id }) => `${path.relative(appRoot, file)}:${index + 1} names ${id}`),
    );
  });
  expect(hits).toEqual([]);
});
