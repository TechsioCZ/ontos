import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

const appRoot = path.resolve(new URL('..', import.meta.url).pathname);

const readAppFile = (relativePath) => readFile(path.join(appRoot, relativePath), 'utf-8');

test('ticketing action adapter preserves policy denial state for the frontend outcome', async () => {
  const source = await readAppFile('verticals/ticketing/api/action-runtime.ts');

  assert.match(source, /readonly state\?: JsonValue/u);
  assert.match(
    source,
    /error\._tag === ['"]OperationPolicyDenied['"] \? toJsonValue\(error\.state\) : undefined/u,
  );
  assert.match(source, /\.\.\.\(state === undefined \? \{\} : \{ state \}\)/u);
});

test('ticketing operation failures declare their CoreSDK HTTP status classes', async () => {
  const operationContract = await readAppFile('verticals/ticketing/shared/core-sdk-operation.ts');
  const apiContract = await readAppFile('verticals/ticketing/shared/api.ts');
  const apiRuntime = await readAppFile('verticals/ticketing/api/index.ts');

  assert.match(operationContract, /HttpApiSchema\.status\(httpStatus\)/u);
  for (const status of [401, 403, 409, 428, 500]) {
    assert.match(operationContract, new RegExp(`\\b${status}\\b`, 'u'));
  }
  assert.match(apiContract, /error: createTaskActionFailureSchema/u);
  assert.match(apiContract, /error: coreSdkOperationFailureSchema/u);
  assert.match(apiContract, /headers: operationContextHeadersSchema/u);
  assert.match(apiRuntime, /outcome\.ok \? Effect\.succeed\(outcome\) : Effect\.fail\(outcome\)/u);
});

test('action generator emits Effect endpoint failures for CoreSDK action errors', async () => {
  const source = await readAppFile('scripts/codesmith/generators/action/index.cjs');

  assert.match(source, /ActionFailureSchema/u);
  for (const status of [401, 403, 409, 428, 500]) {
    assert.match(source, new RegExp(`\\b${status}\\b`, 'u'));
  }
  assert.match(source, /error: \$\{actionCamel\}ActionFailureSchema/u);
  assert.match(source, /outcome\.ok \? Effect\.succeed\(outcome\) : Effect\.fail\(outcome\)/u);
  assert.match(source, /\| \$\{actionPascal\}ActionFailure/u);
});

test('shell and ticketing remote share the UI-kit toast singleton', async () => {
  const shellConfig = await readAppFile('apps/shell-super-app/module-federation.config.ts');
  const ticketingConfig = await readAppFile('verticals/ticketing/module-federation.config.ts');

  for (const source of [shellConfig, ticketingConfig]) {
    assert.match(source, /const uiKitVersion = dependencies\[['"]@techsio\/ui-kit['"]\]/u);
    assert.match(
      source,
      /['"]@techsio\/ui-kit['"]:\s*\{\s*requiredVersion: uiKitVersion,\s*singleton: true,/u,
    );
    assert.match(
      source,
      /['"]@techsio\/ui-kit\/molecules\/toast['"]:\s*\{\s*requiredVersion: uiKitVersion,\s*singleton: true,/u,
    );
  }
});
