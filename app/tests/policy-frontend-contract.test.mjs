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

test('ticketing action denials are Effect endpoint failures with HTTP 409', async () => {
  const actionContract = await readAppFile('verticals/ticketing/shared/actions/create-ticket.ts');
  const apiContract = await readAppFile('verticals/ticketing/shared/api.ts');
  const apiRuntime = await readAppFile('verticals/ticketing/api/index.ts');

  assert.match(actionContract, /createTicketActionFailureSchema/u);
  assert.match(actionContract, /HttpApiSchema\.status\(409\)/u);
  assert.match(apiContract, /error: createTicketActionFailureSchema/u);
  assert.match(apiRuntime, /outcome\.ok \? Effect\.succeed\(outcome\) : Effect\.fail\(outcome\)/u);
});

test('ticketing page presents rejected action messages through the existing Toast', async () => {
  const source = await readAppFile('verticals/ticketing/src/pages/ticketing-experience.tsx');
  const englishLocale = JSON.parse(
    await readAppFile('verticals/ticketing/locales/en/ticketing.json'),
  );

  assert.match(source, /import \{ toaster \} from ['"]@techsio\/ui-kit\/molecules\/toast['"]/u);
  assert.match(source, /isCreateTicketActionFailure\(error\)/u);
  assert.match(source, /description: error\.message/u);
  assert.match(source, /title: t\(['"]ticketing\.taskCollection\.createRejected['"]\)/u);
  assert.match(source, /setCreateTaskCollectionIntentId\(crypto\.randomUUID\(\)\)/u);
  assert.equal(englishLocale.ticketing.taskCollection.createRejected, 'Create Ticket rejected');
  assert.match(source, /type: ['"]error['"]/u);
});

test('action generator emits Effect endpoint failures for CoreSDK action errors', async () => {
  const source = await readAppFile('scripts/codesmith/generators/action/index.cjs');

  assert.match(source, /ActionFailureSchema/u);
  assert.match(source, /HttpApiSchema\.status\(409\)/u);
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
