// @effect-diagnostics nodeBuiltinImport:off -- Inspect source files through the Node filesystem boundary; expires: 2026-12-31.
import { expect, it } from 'effect-rstest';
import { readFile, readdir } from 'node:fs/promises';
import { Effect, Schema, Struct } from 'effect';
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

it.effect('every generated Action has its own statically named command endpoint', () =>
  Effect.gen(function* testProgram1() {
    const files = yield* Effect.promise(() =>
      readdir(new URL('../../src/actions/', import.meta.url)),
    );
    const actions = files
      .filter((file) => file.endsWith('.action.ts'))
      .map((file) => file.replace('.action.ts', ''))
      .filter((slug) => !slug.includes('engagement'));
    const endpoints = Object.values(partyRegistryCommandsApi.groups.partyCommands.endpoints);
    expect(endpoints.length).toBe(actions.length);
    expect(endpoints.map((endpoint) => endpoint.path).toSorted()).toEqual(
      actions.map((slug) => `/party-registry/actions/${slug}`).toSorted(),
    );
    for (const slug of actions) {
      const name = slug
        .split('-')
        .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
        .join('');
      expect(Object.hasOwn(partyRegistryCommandsApi.groups.partyCommands.endpoints, name)).toBe(
        true,
      );
    }
  }),
);

it.effect(
  'missing idempotency reaches the declared 428 while malformed supplied values fail decoding',
  () =>
    Effect.gen(function* decodeContract1() {
      expect(yield* Schema.decodeUnknownEffect(PartyCommandHeadersSchema)({})).toEqual({});
      expect(() =>
        Schema.decodeUnknownSync(PartyCommandHeadersSchema)({ 'idempotency-key': '' }),
      ).toThrow();
    }),
);

it.effect('alias conflict preserves both canonical and submitted references', () =>
  Effect.gen(function* decodeContract2() {
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
    const decodedProblem = yield* Schema.decodeUnknownEffect(
      PartyCommandAliasWriteRejectedProblemSchema,
    )(input);
    expect(Schema.is(PartyCommandAliasWriteRejectedProblemSchema)(decodedProblem)).toBe(true);
    expect(Struct.omit(decodedProblem, ['_tag'])).toEqual(Struct.omit(input, ['_tag']));
  }),
);

it.effect('public commands and clients never import Action runtime implementations', () =>
  Effect.gen(function* testProgram2() {
    const sources = yield* Effect.promise(() =>
      Promise.all(
        ['../../shared/command-api.ts', '../../src/api/party-command-client.ts'].map((path) =>
          readFile(new URL(path, import.meta.url), 'utf-8'),
        ),
      ),
    );
    for (const source of sources) {
      expect(source).not.toMatch(
        /from\s+['"][^'"]*src\/actions|from\s+['"]\.\.\/actions|\.action\.ts|Schema\.(?:Unknown|Any)\b/u,
      );
    }
  }),
);
