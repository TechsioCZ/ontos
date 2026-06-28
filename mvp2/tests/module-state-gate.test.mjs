import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const read = (relativePath) => readFileSync(path.join(root, relativePath), 'utf-8');

test('module-state matrix covers every state for load, read, and mutate', async () => {
  const {
    installedModuleKeys,
    isModuleStateAccessAllowed,
    moduleActivationStates,
    moduleStateAccessKinds,
    moduleStateAccessMatrix,
  } = await import('../packages/shared-contracts/src/index.ts');

  assert.deepEqual(installedModuleKeys, ['properties', 'accounting']);

  for (const state of moduleActivationStates) {
    assert.deepEqual(Object.keys(moduleStateAccessMatrix[state]).sort(), [
      'load',
      'mutate',
      'read',
    ]);

    for (const accessKind of moduleStateAccessKinds) {
      assert.equal(
        isModuleStateAccessAllowed({ accessKind, state }),
        moduleStateAccessMatrix[state][accessKind],
      );
    }
  }

  assert.deepEqual(moduleStateAccessMatrix.active, { load: true, mutate: true, read: true });
  assert.deepEqual(moduleStateAccessMatrix.read_only, { load: true, mutate: false, read: true });
  assert.deepEqual(moduleStateAccessMatrix.deprecated, { load: true, mutate: true, read: true });

  for (const state of ['inactive', 'suspended', 'quarantined', 'archived']) {
    assert.deepEqual(moduleStateAccessMatrix[state], { load: false, mutate: false, read: false });
  }
});

test('Core runtime resolves missing tenant module rows as inactive for every installed module', () => {
  const moduleState = read('packages/core-runtime/src/module-state.ts');

  assert.match(moduleState, /installedModuleKeys\.map\(\(moduleKey\)\s*=>\s*\(\{/u);
  assert.match(moduleState, /state:\s*persisted\.get\(moduleKey\)\s*\?\?\s*'inactive'/u);
  assert.match(moduleState, /row !== undefined && isModuleActivationState\(row\.state\)/u);
  assert.match(moduleState, /:\s*'inactive'/u);
});

test('CoreSDK Module State Gate runs after action.received and before SpiceDB, policy, and handler', () => {
  const coreSDK = read('packages/core-runtime/src/core-sdk.ts');
  const receivedIndex = coreSDK.indexOf("eventType: 'action.received'");
  const gateIndex = coreSDK.indexOf(
    'const moduleStateCheckedContext = await enforceModuleStateGate',
  );
  const spiceDbIndex = coreSDK.indexOf('const authorizedContext = await authorizeWithSpiceDb');
  const policyIndex = coreSDK.indexOf('const policyCheckedContext = await evaluateActionPolicies');
  const handlerIndex = coreSDK.indexOf('const response = await handler(payload');

  assert.ok(receivedIndex > -1);
  assert.ok(gateIndex > receivedIndex);
  assert.ok(spiceDbIndex > gateIndex);
  assert.ok(policyIndex > spiceDbIndex);
  assert.ok(handlerIndex > policyIndex);
  assert.match(coreSDK, /outcomeCode:\s*checked\.outcomeCode/u);
  assert.match(coreSDK, /markActionInvocationStatus\(context,\s*'rejected'\)/u);
  assert.match(coreSDK, /eventType:\s*`\$\{eventPrefix\}\.module_state\.denied`/u);
});

test('Shell gates module-federated remotes and gateway forwarding by backend-resolved module state', () => {
  const authApi = read('apps/shell-super-app/src/effect/auth-api.ts');
  const gateway = read('apps/shell-super-app/api/effect/index.ts');
  const registry = read('apps/shell-super-app/src/modules/installed-modules.ts');
  const verticalComponents = read('apps/shell-super-app/src/routes/vertical-components.tsx');
  const shellFrame = read('apps/shell-super-app/src/routes/shell-frame.tsx');
  const adminPanel = read('apps/shell-super-app/src/routes/module-state-admin-panel.tsx');
  const homePage = read('apps/shell-super-app/src/routes/[lang]/page.tsx');

  assert.match(authApi, /moduleStates:\s*Schema\.Array\(tenantModuleStateSchema\)/u);
  assert.match(authApi, /moduleStateAdmin:\s*moduleStateAdminCapabilitySchema/u);
  assert.match(gateway, /checkModuleStateAccess/u);
  assert.match(gateway, /accessKind:\s*'load'/u);
  assert.match(gateway, /forwardMicroVerticalRequest/u);
  assert.ok(
    gateway.indexOf('checkModuleStateAccess') < gateway.indexOf('forwardMicroVerticalRequest'),
  );
  assert.match(registry, /moduleKey:\s*'accounting'/u);
  assert.match(registry, /moduleKey:\s*'properties'/u);
  assert.doesNotMatch(verticalComponents, /const PropertiesWidget = createHydratedRemote/u);
  assert.doesNotMatch(verticalComponents, /const AccountingWidget = createHydratedRemote/u);
  assert.match(verticalComponents, /isModuleStateAccessAllowed\(\{\s*accessKind:\s*'load'/u);
  assert.match(verticalComponents, /<RemoteSlot specifier=\{module\.widgetRemote\}/u);
  assert.match(verticalComponents, /<RemoteSlot specifier="properties\/Route" \/>/u);
  assert.match(shellFrame, /<ShellAuthProvider>/u);
  assert.match(adminPanel, /context\.moduleStateAdmin\.canChange/u);
  assert.doesNotMatch(adminPanel, /!context\.moduleStateAdmin\.canView/u);
  assert.ok(homePage.indexOf('<AuthControls />') < homePage.indexOf('<ModuleStateAdminPanel />'));
});

test('SpiceDB schema and seed include governed core.modules state administration', () => {
  const moduleState = read('packages/core-runtime/src/module-state.ts');
  const demoAuth = read('packages/core-runtime/src/auth/demo-auth.ts');
  const schema = read('scripts/spicedb/schema.zed');
  const seed = read('scripts/seed-spicedb.mjs');

  assert.match(moduleState, /spiceDbAuthorizationChecker/u);
  assert.doesNotMatch(moduleState, /demoAdminPrincipalId/u);
  assert.doesNotMatch(moduleState, /principalId === demoAdminPrincipalId/u);
  assert.doesNotMatch(demoAuth, /demoModuleStateAuthorizationChecker/u);
  assert.match(schema, /definition core_modules/u);
  assert.match(schema, /permission view = viewer \+ changer/u);
  assert.match(schema, /permission change = changer/u);
  assert.match(seed, /core_modules:\$\{demoTenantId\}_core-modules/u);
  assert.match(seed, /'changer'/u);
});

test('Properties HTTP contract serializes CoreSDK module-state denials', () => {
  const api = read('verticals/properties/shared/effect/api.ts');
  const bff = read('verticals/properties/api/effect/index.ts');

  assert.match(api, /OperationModuleStateDenied/u);
  assert.match(api, /operationModuleStateDeniedSchema/u);
  assert.match(api, /HttpApiSchema\.status\(403\)/u);
  assert.match(bff, /case 'OperationModuleStateDenied'/u);
  assert.match(bff, /createOperationModuleStateDenied/u);
});
