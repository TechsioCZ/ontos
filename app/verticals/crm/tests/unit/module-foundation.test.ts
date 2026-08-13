import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { deriveOntosModuleDeploymentContract } from '../../../../scripts/generate-ontos-module-contract.mts';

const workspaceRoot = path.resolve(import.meta.dirname, '../../../..');
const crmRoot = path.join(workspaceRoot, 'verticals/crm');

test('publishes the safe CRM module identity and generated contribution descriptors', async () => {
  const contract = await deriveOntosModuleDeploymentContract({
    vertical: 'crm',
    workspaceRoot,
  });
  const serialized = JSON.stringify(contract);

  assert.equal(contract.deployment.appId, 'crm');
  assert.equal(contract.manifest.module.id, 'crm.core');
  assert.equal(
    contract.manifest.publicSurface.actions.some(
      ({ actionKey }) => actionKey === 'crm.core.change-customer-primary-contact',
    ),
    true,
  );
  assert.equal(
    contract.manifest.publicSurface.api.some(
      ({ key }) => key === 'crm.core.change-customer-primary-contact-action',
    ),
    true,
  );
  assert.deepEqual(
    contract.manifest.publicSurface.resourceTypes.map(({ key }) => key),
    ['crm.core.contact', 'crm.core.customer', 'crm.core.deal'],
  );
  assert.deepEqual(
    contract.manifest.publicSurface.shellContributions.resourceDetails.map(
      ({ resourceType }) => resourceType,
    ),
    ['crm.core.contact', 'crm.core.customer', 'crm.core.deal'],
  );
  assert.deepEqual(
    contract.manifest.publicSurface.shellContributions.timelines.map(
      ({ resourceType }) => resourceType,
    ),
    ['crm.core.customer'],
  );
  assert.doesNotMatch(
    serialized,
    /handlerPath|importPath|registrationPath|sourcePath|vertical\.registration/u,
  );
});

test('keeps complete English and Czech CRM catalogs owner-local', async () => {
  const [english, czech, packageJson] = await Promise.all(
    ['locales/en/crm.json', 'locales/cs/crm.json', 'package.json'].map(async (relativePath) =>
      JSON.parse(await readFile(path.join(crmRoot, relativePath), 'utf-8')),
    ),
  );

  assert.deepEqual(Object.keys(english.crm.pages).toSorted(), ['customers', 'deals']);
  assert.deepEqual(Object.keys(czech.crm.pages).toSorted(), ['customers', 'deals']);
  assert.deepEqual(Object.keys(english.crm.pages.customers.unavailable).toSorted(), [
    'description',
    'retry',
    'title',
  ]);
  assert.deepEqual(Object.keys(czech.crm.pages.deals.unavailable).toSorted(), [
    'description',
    'retry',
    'title',
  ]);
  assert.equal(packageJson.exports['./locales/en'], './locales/en/crm.json');
  assert.equal(packageJson.exports['./locales/cs'], './locales/cs/crm.json');
  assert.deepEqual(Object.keys(packageJson.exports).toSorted(), ['./locales/cs', './locales/en']);
});

test('publishes only the generated CRM page components and no starter CRUD surface', async () => {
  const [customersEntry, dealsEntry, federationConfig, federationEntry, sharedApi] =
    await Promise.all([
      readFile(path.join(crmRoot, 'src/federation/page-customers.ts'), 'utf-8'),
      readFile(path.join(crmRoot, 'src/federation/page-deals.ts'), 'utf-8'),
      readFile(path.join(crmRoot, 'module-federation.config.ts'), 'utf-8'),
      readFile(path.join(crmRoot, 'src/federation-entry.tsx'), 'utf-8'),
      readFile(path.join(crmRoot, 'shared/api.ts'), 'utf-8'),
    ]);

  assert.match(federationConfig, /'\.\/PageCustomers': '\.\/src\/federation\/page-customers\.ts'/u);
  assert.match(federationConfig, /'\.\/PageDeals': '\.\/src\/federation\/page-deals\.ts'/u);
  assert.match(federationEntry, /import '\.\/routes\/index\.css';/u);
  assert.match(federationEntry, /CrmFederatedI18nBoundary/u);
  assert.match(customersEntry, /PageCustomers as default/u);
  assert.match(dealsEntry, /PageDeals as default/u);
  assert.doesNotMatch(federationConfig, /'\.\/PageCustomers': '[^']*routes\/\[lang\]/u);
  assert.doesNotMatch(federationConfig, /'\.\/PageDeals': '[^']*routes\/\[lang\]/u);
  assert.doesNotMatch(federationConfig, /'\.\/(?:Route|Widget)'/u);
  assert.doesNotMatch(sharedApi, /HttpApiEndpoint\.post\([^)]*'\/crm'/u);
  assert.doesNotMatch(sharedApi, /listCrm|getCrm|createCrm/u);
});
