// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { customerAresLookupRead } from '../../src/api/customer-ares-lookup.read.ts';
import { crmE2eCustomers } from '../support/e2e-customers.ts';

const customerBusinessFields = [
  'dic',
  'dissolvedOn',
  'establishedOn',
  'ico',
  'legalFormCode',
  'name',
] as const;

const collectFiles = async (directory: URL): Promise<URL[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
      return entry.isDirectory() ? collectFiles(url) : Promise.resolve([url]);
    }),
  );
  return files.flat().toSorted((left, right) => left.pathname.localeCompare(right.pathname));
};

const sourceFiles = (directory: URL) =>
  collectFiles(directory).then((files) =>
    files.filter((file) => /\.(?:js|sql|ts|tsx)$/u.test(file.pathname)),
  );

const readSources = (files: readonly URL[]) =>
  Promise.all(files.map(async (file) => ({ file, source: await readFile(file, 'utf-8') })));

const readJson = async (file: URL): Promise<unknown> => {
  const source = await readFile(file, 'utf-8');
  return JSON.parse(source);
};

const leafPaths = (value: unknown, prefix = ''): string[] => {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix.length === 0 ? key : `${prefix}.${key}`;
    return typeof child === 'object' && child !== null ? leafPaths(child, path) : [path];
  });
};

test('keeps Czech/English CRM copy and complete/null Customer fixtures structurally aligned', async () => {
  const [czech, english, fixtureSource] = await Promise.all([
    readJson(new URL('../../locales/cs/crm.json', import.meta.url)),
    readJson(new URL('../../locales/en/crm.json', import.meta.url)),
    readFile(new URL('../support/e2e-customers.ts', import.meta.url), 'utf-8'),
  ]);

  assert.deepEqual(leafPaths(czech).toSorted(), leafPaths(english).toSorted());
  for (const catalog of [czech, english]) {
    const serialized = JSON.stringify(catalog);
    assert.doesNotMatch(serialized, /:\s*"\s*"/u);
  }

  assert.deepEqual(
    customerBusinessFields.map((field) => crmE2eCustomers.active[field]),
    ['CZ00123456', '2026-08-17', '2020-01-02', '00123456', '112', 'E2E Alpha Customer'],
  );
  assert.deepEqual(
    customerBusinessFields.slice(0, -1).map((field) => crmE2eCustomers.archived[field]),
    [null, null, null, null, null],
  );
  assert.match(crmE2eCustomers.active.ico ?? '', /^0\d{7}$/u);
  assert.match(
    fixtureSource,
    /\(tenant_id, customer_id, name, ico, dic, legal_form_code,\s*established_on, dissolved_on,/u,
  );
});

test('keeps browser Customer flows on generated Effect clients and ARES server-side', async () => {
  const browserFileGroups = await Promise.all(
    [
      new URL('../../src/features/customers/', import.meta.url),
      new URL('../../src/federation/', import.meta.url),
      new URL('../../src/routes/', import.meta.url),
    ].map(sourceFiles),
  );
  const browserFiles = browserFileGroups.flat().filter((file) => file.pathname.endsWith('.tsx'));
  const aresCallers: string[] = [];

  for (const { file, source } of await readSources(browserFiles)) {
    assert.doesNotMatch(source, /\bfetch\s*\(/u, file.pathname);
    assert.doesNotMatch(source, /ares\.gov\.cz/u, file.pathname);
    assert.doesNotMatch(
      source,
      /from\s+['"][^'"]*\/(?:actions|db|integrations|services)\//u,
      file.pathname,
    );
    for (const match of source.matchAll(/from\s+['"](?<specifier>[^'"]*\/api\/[^'"]+)['"]/gu)) {
      assert.match(
        match.groups?.['specifier'] ?? '',
        /\/(?:crm-client|[^/]+-client)\.ts$/u,
        file.pathname,
      );
    }
    if (source.includes('ares.gov.cz')) {
      aresCallers.push(file.pathname);
    }
  }
  assert.deepEqual(aresCallers, []);

  const productionFileGroups = await Promise.all(
    [
      new URL('../../api/', import.meta.url),
      new URL('../../shared/', import.meta.url),
      new URL('../../src/', import.meta.url),
    ].map(sourceFiles),
  );
  const productionFiles = productionFileGroups.flat();
  const upstreamUrls: string[] = [];
  for (const { file, source } of await readSources(productionFiles)) {
    if (source.includes('ares.gov.cz')) {
      upstreamUrls.push(file.pathname);
    }
  }
  assert.equal(upstreamUrls.length, 1);
  assert.match(upstreamUrls[0] ?? '', /src\/integrations\/ares\/ares-subject\.service\.ts$/u);

  const presentationFiles = [
    new URL('../../src/features/customers/customer-ares-loader.tsx', import.meta.url),
    new URL('../../src/features/customers/customer-form.tsx', import.meta.url),
  ];
  for (const { file: presentationFile, source } of await readSources(presentationFiles)) {
    assert.doesNotMatch(source, /\/(?:api|integrations|services)\//u, presentationFile.pathname);
    assert.doesNotMatch(source, /\b(?:Effect|HttpClient|fetch)\b/u, presentationFile.pathname);
  }

  assert.equal(customerAresLookupRead.descriptor.entrypoint.role, 'api');
  assert.equal(customerAresLookupRead.descriptor.entrypoint.access, 'read');
  assert.equal(customerAresLookupRead.descriptor.readKey, 'crm.core.api.customer-ares-lookup');
  const actionFiles = await readdir(new URL('../../src/actions/', import.meta.url));
  assert.equal(
    actionFiles.some((file) => file.includes('ares')),
    false,
  );
});

test('rejects Customer address, ARES metadata, CZ-NACE, and activity scope in production', async () => {
  const roots = [
    new URL('../../api/', import.meta.url),
    new URL('../../drizzle/', import.meta.url),
    new URL('../../shared/', import.meta.url),
    new URL('../../src/', import.meta.url),
  ];
  const fileGroups = await Promise.all(roots.map(sourceFiles));
  const files = fileGroups.flat();
  const forbidden =
    /\b(?:AresData|activities|activity|address|addresses|aresLoadedAt|ares_loaded_at|czNace|cz_nace|datumAktualizace|legalName|primarniZdroj|sidlo)\b/u;

  for (const { file, source } of await readSources(files)) {
    assert.doesNotMatch(source, forbidden, file.pathname);
  }
});
