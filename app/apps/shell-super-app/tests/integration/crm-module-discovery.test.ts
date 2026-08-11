import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Effect } from 'effect';
import { deriveOntosModuleDeploymentContract } from '../../../../scripts/generate-ontos-module-contract.mts';
import { deriveDeploymentAllowlist } from '../../api/modules/deployment-allowlist.ts';
import type { DeploymentAllowlist } from '../../api/modules/deployment-allowlist.ts';
import { makeInstalledModuleCatalogLoader } from '../../api/modules/installed-module-catalog.ts';

const workspaceRoot = path.resolve(import.meta.dirname, '../../../..');
const contractUrl = 'http://localhost:4101/.well-known/ontos-module-manifest.json';
const response = (document: unknown) => Response.json(document);

const crmAllowlist = (): DeploymentAllowlist =>
  Object.freeze({
    entries: Object.freeze([{ appId: 'crm', contractUrl }]),
    revision: 'crm-foundation-test',
  });

test('discovers the generated crm/crm.core contract through the configured allowlist', async () => {
  const [topology, overlay, contract] = await Promise.all([
    readFile(path.join(workspaceRoot, 'topology/reference-topology.json'), 'utf-8').then(
      JSON.parse,
    ),
    readFile(path.join(workspaceRoot, 'topology/local-overlays/development.json'), 'utf-8').then(
      JSON.parse,
    ),
    deriveOntosModuleDeploymentContract({ vertical: 'crm', workspaceRoot }),
  ]);
  const allowlist = await Effect.runPromise(
    deriveDeploymentAllowlist({ environment: 'development', overlay, topology }),
  );
  assert.deepEqual(allowlist.entries, [{ appId: 'crm', contractUrl }]);

  const catalog = await Effect.runPromise(
    makeInstalledModuleCatalogLoader(allowlist, () => Promise.resolve(response(contract))),
  );
  assert.equal(catalog.getByDeploymentAppId('crm')?.manifest.module.id, 'crm.core');
  assert.equal(catalog.getByModuleId('crm.core')?.deployment.appId, 'crm');
});

test('fails the complete CRM snapshot for unavailable or mismatched deployment identity', async () => {
  const contract = await deriveOntosModuleDeploymentContract({ vertical: 'crm', workspaceRoot });
  await assert.rejects(
    Effect.runPromise(
      makeInstalledModuleCatalogLoader(crmAllowlist(), () =>
        Promise.reject(new Error('CRM deployment unavailable')),
      ),
    ),
    (error: { readonly _tag?: string }) => error._tag === 'InstalledModuleCatalogUnavailableError',
  );
  await assert.rejects(
    Effect.runPromise(
      makeInstalledModuleCatalogLoader(crmAllowlist(), () =>
        Promise.resolve(
          response({ ...contract, deployment: { ...contract.deployment, appId: 'other-crm' } }),
        ),
      ),
    ),
    (error: { readonly _tag?: string }) => error._tag === 'InstalledModuleCatalogInvalidError',
  );
});

test('rejects a second deployment that claims the crm.core module identity', async () => {
  const contract = await deriveOntosModuleDeploymentContract({ vertical: 'crm', workspaceRoot });
  const allowlist: DeploymentAllowlist = Object.freeze({
    entries: Object.freeze([
      { appId: 'crm', contractUrl },
      {
        appId: 'documents-center',
        contractUrl: 'http://localhost:4102/.well-known/ontos-module-manifest.json',
      },
    ]),
    revision: 'crm-module-mismatch-test',
  });
  await assert.rejects(
    Effect.runPromise(
      makeInstalledModuleCatalogLoader(allowlist, (url) =>
        Promise.resolve(
          response(
            String(url) === contractUrl
              ? contract
              : { ...contract, deployment: { ...contract.deployment, appId: 'documents-center' } },
          ),
        ),
      ),
    ),
    (error: { readonly _tag?: string }) => error._tag === 'InstalledModuleCatalogInvalidError',
  );
});
