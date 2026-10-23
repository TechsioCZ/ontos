// @rstest-environment node
/**
 * Core and the Shell platform must not know any MicroVertical: every vertical id, module id, tool name, label,
 * navigation entry, review rule or follow-up comes from the composed module contracts. This test fails when a
 * vertical id appears in that source as a quoted literal or a path segment, or a module id appears anywhere.
 * Companies are tenant data too: the Shell UI must not name a demo company or key behaviour by its legal entity id.
 * Allowed exceptions: demo guide content and seed data (tenant data, not platform behaviour).
 */
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
import { expect, it } from '@rstest/core';
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

const verticals = readdirSync(verticalsRoot).flatMap((directory) => {
  try {
    const manifest = JSON.parse(readFileSync(path.join(verticalsRoot, directory, 'package.json'), 'utf-8')) as {
      readonly modernjs?: { readonly appId?: string; readonly ontosModule?: { readonly moduleId?: string } };
    };
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

const escape = (value: string): string => value.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');

const patterns = verticals.flatMap(({ appId, moduleId }) => [
  { id: appId, pattern: new RegExp(`['"\`/]${escape(appId)}['"\`/]`, 'u') },
  ...(moduleId === undefined ? [] : [{ id: moduleId, pattern: new RegExp(escape(moduleId), 'u') }]),
]);

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
    { id: legalEntityId, pattern: new RegExp(escape(legalEntityId), 'u') },
    // A quoted suffix of the id, e.g. `'020'`, used to key company behaviour without naming the full id.
    { id: `${legalEntityId} suffix`, pattern: new RegExp(`['"\`]0+${escape(significant)}['"\`]`, 'u') },
    { id: legalName, pattern: new RegExp(`(?<![\\p{L}\\p{N}])${escape(baseName(legalName))}(?![\\p{L}\\p{N}])`, 'u') },
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

it('keeps Core and the whole Shell platform free of vertical ids', () => {
  const hits = GUARDED.flatMap(filesOf).flatMap((file) => {
    const lines = readFileSync(file, 'utf-8').split('\n');
    return lines.flatMap((line, index) =>
      patterns
        .filter(({ pattern }) => pattern.test(line))
        .map(({ id }) => `${path.relative(appRoot, file)}:${index + 1} names ${id}`),
    );
  });
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
