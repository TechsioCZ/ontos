// @rstest-environment node
/**
 * The Shell UI keeps two boundaries no workspace checker covers: it never takes a runtime import of a Shell server
 * implementation module, and it names no demo company (companies are tenant data, never platform behaviour).
 * Vertical ids in Core and the Shell platform are rejected by `scripts/check-lean-core-dependencies.mts`
 * (`checkPlatformVerticalIds`); production imports of Core's test fixtures by `scripts/check-database-access-boundaries.mts`.
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
import { expect, it } from 'effect-rstest';
import { parseSync } from 'oxc-parser';

const appRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const shellUiRoot = path.join(appRoot, 'apps/shell-super-app/src');
const shellApiRoot = path.join(appRoot, 'apps/shell-super-app/api');

/** Demo guide content and seed data name the demo tenants on purpose. */
const EXCEPTIONS = [path.join(shellUiRoot, 'demo-guide/guides') + path.sep];
const SEED_DIRECTORY = `${path.sep}demo-seed${path.sep}`;

const shellUiFiles = readdirSync(shellUiRoot, { recursive: true })
  .map((entry) => path.join(shellUiRoot, String(entry)))
  .filter(
    (file) =>
      /\.(?:mts|ts|tsx)$/u.test(file) &&
      !file.includes(`${path.sep}node_modules${path.sep}`) &&
      !file.includes(SEED_DIRECTORY) &&
      !EXCEPTIONS.some((exception) => file.startsWith(exception)) &&
      statSync(file).isFile(),
  );

const escapeRegex = (value: string): string => value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

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

it('scans the Shell UI sources', () => {
  expect(shellUiFiles.length).toBeGreaterThan(20);
});

it('keeps runtime browser imports out of server implementation modules', () => {
  const hits = shellUiFiles.flatMap((file) =>
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
      return target.startsWith(`${shellApiRoot}${path.sep}`) && target !== path.join(shellApiRoot, 'index.ts')
        ? [`${path.relative(appRoot, file)} imports ${path.relative(appRoot, target)}`]
        : [];
    }),
  );
  expect(hits).toEqual([]);
});

it('keeps the Shell UI free of demo company ids and names', () => {
  expect(companyPatterns.length).toBe(companies.length * 3);
  const hits = shellUiFiles.flatMap((file) =>
    readFileSync(file, 'utf-8')
      .split('\n')
      .flatMap((line, index) =>
        companyPatterns
          .filter(({ pattern }) => pattern.test(line))
          .map(({ id }) => `${path.relative(appRoot, file)}:${index + 1} names ${id}`),
      ),
  );
  expect(hits).toEqual([]);
});
