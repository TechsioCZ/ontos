// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { Schema } from 'effect';
import {
  partyRegistryCommandsApi,
  PartyCommandAliasWriteRejectedProblemSchema,
  PartyCommandHeadersSchema,
} from '../../shared/command-api.ts';

const ref = (id: string) => ({
  moduleId: 'party.registry',
  resourceId: id,
  resourceType: 'party.registry.party',
  tenantId: '10000000-0000-4000-8000-000000000001',
});

test('every generated Action has its own statically named command endpoint', async () => {
  const files = await readdir(new URL('../../src/actions/', import.meta.url));
  const actions = files
    .filter((file) => file.endsWith('.action.ts'))
    .map((file) => file.replace('.action.ts', ''));
  const endpoints = Object.values(partyRegistryCommandsApi.groups.partyCommands.endpoints);
  assert.equal(endpoints.length, actions.length);
  assert.deepEqual(
    endpoints.map((endpoint) => endpoint.path).toSorted(),
    actions.map((slug) => `/party-registry/actions/${slug}`).toSorted(),
  );
  for (const slug of actions) {
    const name = slug
      .split('-')
      .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
      .join('');
    assert.ok(Object.hasOwn(partyRegistryCommandsApi.groups.partyCommands.endpoints, name));
  }
});

test('missing idempotency reaches the declared 428 while malformed supplied values fail decoding', () => {
  assert.deepEqual(Schema.decodeUnknownSync(PartyCommandHeadersSchema)({}), {});
  assert.throws(() =>
    Schema.decodeUnknownSync(PartyCommandHeadersSchema)({ 'idempotency-key': '' }),
  );
});

test('alias conflict preserves both canonical and submitted references', () => {
  const input = {
    _tag: 'PartyCommandAliasWriteRejectedProblem',
    aliasPartyRef: ref('10000000-0000-4000-8000-000000000002'),
    canonicalPartyRef: ref('10000000-0000-4000-8000-000000000003'),
    code: 'party_alias_write_rejected',
    detail: 'Retry with the canonical Party.',
    status: 409,
    title: 'Canonical Party required',
    type: 'urn:ontos:party:alias-write-rejected',
  };
  assert.deepEqual(
    Schema.decodeUnknownSync(PartyCommandAliasWriteRejectedProblemSchema)(input),
    input,
  );
});

test('public commands and clients never import Action runtime implementations', async () => {
  const sources = await Promise.all(
    ['../../shared/command-api.ts', '../../src/api/party-command-client.ts'].map((path) =>
      readFile(new URL(path, import.meta.url), 'utf-8'),
    ),
  );
  for (const source of sources) {
    assert.doesNotMatch(
      source,
      /from\s+['"][^'"]*src\/actions|from\s+['"]\.\.\/actions|\.action\.ts|Schema\.(?:Unknown|Any)\b/u,
    );
  }
});
