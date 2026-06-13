import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const read = (relativePath) => readFileSync(path.join(root, relativePath), 'utf-8');
const readJson = (relativePath) => JSON.parse(read(relativePath));

test('workspace uses latest allowed UltraModern .120 generator packages', () => {
  const packageJson = readJson('package.json');
  const workspace = read('pnpm-workspace.yaml');

  assert.equal(packageJson.packageManager, 'pnpm@11.5.3');
  assert.match(
    packageJson.devDependencies['@modern-js/create'],
    /@bleedingdev\/modern-js-create@3\.2\.0-ultramodern\.120/u,
  );
  assert.match(workspace, /minimumReleaseAge:\s*1440/u);
  assert.match(workspace, /'@bleedingdev\/modern-js-\*'/u);
});

test('Day 1 and Day 2 shell registry exposes active MicroVertical descriptors', () => {
  const registry = read('apps/shell-super-app/src/verticals/installed.registry.ts');
  const serverRegistry = read('apps/shell-super-app/api/effect/runtime-registrations.ts');
  const discovery = read('apps/shell-super-app/src/verticals/module-discovery.ts');
  const propertyManifest = read('verticals/property-registry/vertical.manifest.ts');
  const propertyAction = read('verticals/property-registry/src/actions/create-unit.action.ts');
  const accountingManifest = read('verticals/accounting-core/vertical.manifest.ts');
  const accountingAction = read(
    'verticals/accounting-core/src/actions/create-draft-entry.action.ts',
  );

  assert.match(registry, /@mvp\/property-registry\/vertical\.manifest/u);
  assert.match(registry, /@mvp\/accounting-core\/vertical\.manifest/u);
  assert.match(serverRegistry, /@mvp\/property-registry\/vertical\.registration/u);
  assert.match(serverRegistry, /@mvp\/accounting-core\/vertical\.registration/u);
  assert.match(registry, /moduleId:\s*'property\.registry'/u);
  assert.match(registry, /moduleId:\s*'accounting\.core'/u);
  assert.match(propertyAction, /key:\s*'property\.registry\.createUnit'/u);
  assert.match(accountingAction, /key:\s*createDraftEntryActionId/u);
  assert.match(propertyManifest, /key:\s*'property\.unit'/u);
  assert.match(accountingManifest, /key:\s*'accounting\.draft_entry'/u);
  assert.match(registry, /state:\s*'active'/u);
  assert.match(discovery, /resolveVisibleVerticals/u);
});

test('cross-MicroVertical public components are consumed through Module Federation', () => {
  const discovery = read('apps/shell-super-app/src/verticals/module-discovery.ts');
  const shellComponents = read('apps/shell-super-app/src/routes/vertical-components.tsx');
  const propertyMf = read('verticals/property-registry/module-federation.config.ts');
  const accountingMf = read('verticals/accounting-core/module-federation.config.ts');
  const accountingRemote = read(
    'verticals/accounting-core/src/components/remote-property-unit-card.tsx',
  );

  const propertyManifest = read('verticals/property-registry/vertical.manifest.ts');
  const accountingManifest = read('verticals/accounting-core/vertical.manifest.ts');

  assert.match(propertyManifest, /PropertyUnitCard/u);
  assert.match(accountingManifest, /AccountingDraftEntryCard/u);
  assert.match(discovery, /getVerticalPublicComponentSpecifier/u);
  assert.match(shellComponents, /loadRemote/u);
  assert.match(shellComponents, /data-mf-public-component/u);
  assert.match(propertyMf, /'\.\/PropertyUnitCard'/u);
  assert.match(accountingMf, /'\.\/AccountingDraftEntryCard'/u);
  assert.match(accountingRemote, /remote:\s*'propertyRegistry'/u);
  assert.match(accountingRemote, /exposedModule:\s*'\.\/PropertyUnitCard'/u);
  assert.doesNotMatch(accountingRemote, /@mvp\/property-registry\/src/u);
});

test('Day 3 shared Effect API declares all six required Shell operations', () => {
  const sharedApi = read('packages/shared-effect-api/src/index.ts');

  for (const operation of [
    'signInDemoUser',
    'signOutDemoUser',
    'getCurrentRuntimeContext',
    'checkModuleWritePermission',
    'checkModuleStateGate',
    'checkPolicyGate',
    'checkProtectedResourceRead',
  ]) {
    assert.match(sharedApi, new RegExp(operation, 'u'));
  }

  assert.match(sharedApi, /Schema\.Struct/u);
  assert.match(sharedApi, /betterAuthUser/u);
  assert.match(sharedApi, /principal/u);
  assert.match(sharedApi, /tenant/u);
  assert.match(sharedApi, /legalEntity/u);
  assert.match(sharedApi, /moduleStates/u);
});

test('Day 3 Shell BFF delegates to Core public APIs and does not write runtime evidence rows', () => {
  const shellBff = read('apps/shell-super-app/api/effect/index.ts');
  const serverRegistry = read('apps/shell-super-app/api/effect/runtime-registrations.ts');
  const shellUi = read('apps/shell-super-app/src/routes/vertical-components.tsx');
  const shellClient = read('apps/shell-super-app/src/effect/day3-runtime-client.ts');

  assert.match(shellBff, /from '@mvp\/core-runtime'/u);
  assert.doesNotMatch(shellBff, /better-auth/u);
  assert.doesNotMatch(shellBff, /spicedb/u);
  assert.doesNotMatch(shellBff, /drizzle/u);
  assert.doesNotMatch(shellBff, /insert|update|delete|upsert/u);
  assert.match(shellUi, /data-day3-runtime-context=.*read-only/u);
  assert.match(shellUi, /data-effect-operation="signInDemoUser"/u);
  assert.match(shellUi, /data-effect-operation="signOutDemoUser"/u);
  assert.match(shellUi, /onClick/u);
  assert.match(shellUi, /setRuntimeContext/u);
  assert.match(shellClient, /sign-in-demo-user/u);
  assert.match(shellClient, /sign-out-demo-user/u);
  assert.match(shellClient, /check-protected-resource-read/u);
  assert.doesNotMatch(shellClient, /demoUserKey,\n\s*resourceId/u);
  assert.match(shellUi, /Resource A/u);
  assert.match(shellUi, /Resource B/u);
  assert.match(shellUi, /Resource C/u);
  assert.match(shellUi, /Expected for Admin A: allowed by SpiceDB/u);
  assert.match(shellUi, /Expected for Admin A: allowed\./u);
  assert.match(shellUi, /Expected for Viewer A: allowed\./u);
  assert.match(shellUi, /Expected for Viewer A: denied by policy/u);
  assert.match(shellUi, /demoUserKey = demoUserKeyFromContext\(runtimeContext\)/u);
  assert.match(read('apps/shell-super-app/api/effect/index.ts'), /requestHeaders/u);
  assert.match(
    read('packages/core-runtime/src/index.ts'),
    /demoUserKey === 'demo-viewer-a' && request\.resourceId === 'resource-c'/u,
  );
  assert.doesNotMatch(shellUi, /User A -> Resource A/u);
  assert.doesNotMatch(shellUi, /User B -> Resource C/u);
  assert.match(shellUi, /data-day3-read-decision-stage/u);
  assert.doesNotMatch(shellUi, /tenant selector|selectTenant|tenantSelector/u);
});

test('Core runtime public export surface is present when the package exists', () => {
  const packagePath = path.join(root, 'packages/core-runtime/package.json');
  if (!existsSync(packagePath)) {
    assert.ok(true);
    return;
  }

  const packageJson = readJson('packages/core-runtime/package.json');
  const index = read('packages/core-runtime/src/index.ts');

  assert.equal(packageJson.name, '@mvp/core-runtime');
  for (const exportName of [
    'signInDemoUser',
    'signOutDemoUser',
    'getCurrentRuntimeContext',
    'checkModuleWritePermission',
    'checkModuleStateGate',
    'checkPolicyGate',
    'checkProtectedResourceRead',
  ]) {
    assert.match(index, new RegExp(`export .*${exportName}`, 'u'));
  }
});

test('Day 4 create-unit action goes through Core, SpiceDB, and typed Drizzle writes', () => {
  const sharedApi = read('packages/shared-effect-api/src/index.ts');
  const shellBff = read('apps/shell-super-app/api/effect/index.ts');
  const serverRegistry = read('apps/shell-super-app/api/effect/runtime-registrations.ts');
  const shellClient = read('apps/shell-super-app/src/effect/day3-runtime-client.ts');
  const shellUi = read('apps/shell-super-app/src/routes/vertical-components.tsx');
  const actionRuntime = read('packages/core-runtime/src/action-runtime.ts');
  const authorization = read('packages/core-runtime/src/authorization.ts');
  const drizzleSchema = read('packages/core-runtime/src/db/schema.ts');
  const propertyQueries = read('verticals/property-registry/src/db/property-queries.ts');
  const propertyAction = read('verticals/property-registry/src/actions/create-unit.action.ts');
  const propertyHandler = read('verticals/property-registry/src/actions/create-unit.handler.ts');
  const spiceDbSchema = read('scripts/spicedb/schema.zed');
  const spiceDbSeed = read('scripts/seed-spicedb.mjs');

  assert.match(sharedApi, /checkActionAttemptCapability/u);
  assert.match(sharedApi, /executeCreateUnitAction/u);
  assert.match(sharedApi, /\/effect\/day4\/create-unit/u);
  assert.match(shellBff, /checkActionAttemptCapabilityForSession/u);
  assert.match(shellBff, /executeActionForSession/u);
  assert.match(shellBff, /serverInstalledVerticalRegistrations/u);
  assert.match(serverRegistry, /serverInstalledVerticalRegistrations/u);
  assert.doesNotMatch(shellBff, /drizzle|propertyUnits|insert|update|delete|upsert/u);
  assert.match(shellClient, /\/effect\/day4\/check-action-attempt-capability/u);
  assert.match(shellClient, /\/effect\/day4\/create-unit/u);
  assert.match(shellUi, /data-day4-action-button/u);
  assert.match(shellUi, /actionCapability\?\.allowed !== true/u);
  assert.doesNotMatch(shellUi, /demoUserKey === 'demo-viewer-a'.*disabled/u);

  assert.match(actionRuntime, /Schema\.decodeUnknownSync/u);
  assert.match(actionRuntime, /checkModuleWriteState/u);
  assert.match(actionRuntime, /checkModuleWrite/u);
  assert.match(actionRuntime, /evaluateWritePolicy/u);
  assert.match(authorization, /checkModuleActionAttempt/u);
  assert.match(authorization, /permission:\s*'attempt_action'/u);

  assert.match(drizzleSchema, /export const propertyUnits/u);
  assert.match(drizzleSchema, /export type PropertyUnitInsert/u);
  assert.equal(
    existsSync(path.join(root, 'packages/core-runtime/src/db/property-queries.ts')),
    false,
  );
  assert.match(propertyQueries, /db\s*\n\s*\.insert\(propertyUnits\)/u);
  assert.match(propertyQueries, /satisfies PropertyUnitInsert/u);
  assert.match(propertyQueries, /code: input\.code/u);
  assert.doesNotMatch(propertyQueries, /\.insert\(propertyUnits\)[\s\S]*?\.onConflictDoUpdate/u);
  assert.doesNotMatch(propertyQueries, /randomBytes|toString\('hex'\)|slugCode/u);
  assert.doesNotMatch(propertyQueries, /sql`|db\.execute|postgres\(/u);
  assert.match(propertyAction, /writesCanonicalRows:\s*true/u);
  assert.match(propertyHandler, /createPropertyUnitProof/u);
  assert.match(propertyHandler, /unitCodeWithRandomSuffix/u);
  assert.match(propertyHandler, /randomBytes\(4\)\.toString\('hex'\)/u);
  assert.doesNotMatch(propertyHandler, /Effect\.succeed|not_implemented/u);

  assert.match(spiceDbSchema, /relation action_caller: user/u);
  assert.match(spiceDbSchema, /permission attempt_action = action_caller/u);
  assert.match(
    spiceDbSeed,
    /\['module:tenant-a_property-registry', 'action_caller', 'user:ba-user-demo-admin-a'\]/u,
  );
  assert.match(
    spiceDbSeed,
    /\['module:tenant-a_property-registry', 'writer', 'user:ba-user-demo-admin-a'\]/u,
  );
  assert.match(
    spiceDbSeed,
    /\['module:tenant-b_property-registry', 'action_caller', 'user:ba-user-demo-admin-b'\]/u,
  );
  assert.doesNotMatch(
    spiceDbSeed,
    /\['module:tenant-b_property-registry', 'writer', 'user:ba-user-demo-admin-b'\]/u,
  );
  assert.doesNotMatch(spiceDbSeed, /ba-user-demo-viewer-a.*action_caller/u);
});
