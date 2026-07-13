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

test('ticketing page presents rejected action messages through the existing Toast', async () => {
  const source = await readAppFile('verticals/ticketing/src/pages/ticketing-experience.tsx');

  assert.match(source, /import \{ toaster \} from ['"]@techsio\/ui-kit\/molecules\/toast['"]/u);
  assert.match(source, /outcome\.ok/u);
  assert.match(source, /description: outcome\.message/u);
  assert.match(source, /title: ['"]Create Ticket rejected['"]/u);
  assert.match(source, /type: ['"]error['"]/u);
});
