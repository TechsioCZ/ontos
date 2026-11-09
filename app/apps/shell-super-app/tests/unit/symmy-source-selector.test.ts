import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  SymmySelectedSourceCodeSchema,
  decodeSymmySourceSelector,
  encodeSymmySourceSelector,
  SymmySourceSelectorError,
  verifySymmySourceSelector,
} from '@app/symmy-integration/symmy-source-selector';

const targetResourceId = '30000000-0000-4000-8000-00000000000a';
const scope = {
  issuerId: 'source-issuer',
  routeId: '10000000-0000-4000-8000-000000000001',
  selectorKind: 'PRICE_GROUP' as const,
  sourceNamespace: 'price-groups',
  sourceRouteId: 'logical-shared-price-list-route',
  tenantId: '20000000-0000-4000-8000-000000000001',
};

describe('qualified source code wire representation', () => {
  it.effect('round-trips every opaque source key in one unreserved URL segment', () =>
    Effect.gen(function* losslessSourceKeys() {
      for (const key of [
        'CZ wholesale',
        'CZ/wholesale',
        '../literal/source/key',
        'Žluťoučký / 価格',
        'Café',
        'Cafe\u0301',
        'x'.repeat(300),
        '界'.repeat(300),
      ]) {
        const code = encodeSymmySourceSelector(scope, key, targetResourceId);
        expect(Schema.is(SymmySelectedSourceCodeSchema)(code)).toBe(true);
        expect(code).toHaveLength(87);
        expect(code).not.toContain('%');
        expect(code).not.toContain('/');
        const url = new URL(`/api/symmy/v1/price-lists/${code}/prices/batch`, 'https://shell.example.test');
        expect(url.pathname.split('/')).toHaveLength(8);
        expect(url.pathname.split('/')[5]).toBe(code);
        const decoded = yield* decodeSymmySourceSelector(code);
        expect(yield* verifySymmySourceSelector(decoded, scope, key, targetResourceId)).toBe(key);
      }
      expect(encodeSymmySourceSelector(scope, 'CZ wholesale', targetResourceId)).toHaveLength(87);
      expect(encodeSymmySourceSelector(scope, 'Café', targetResourceId)).not.toBe(
        encodeSymmySourceSelector(scope, 'Cafe\u0301', targetResourceId),
      );
    }),
  );
  it.effect('uses the logical source route across different GET and POST enrollment rows', () =>
    Effect.gen(function* sharedLogicalSourceIdentity() {
      const post = { ...scope, routeId: '10000000-0000-4000-8000-000000000002' };
      const code = encodeSymmySourceSelector(scope, 'CZ wholesale', targetResourceId);
      expect(encodeSymmySourceSelector(post, 'CZ wholesale', targetResourceId)).toBe(code);
      expect(
        yield* verifySymmySourceSelector(
          yield* decodeSymmySourceSelector(code),
          post,
          'CZ wholesale',
          targetResourceId,
        ),
      ).toBe('CZ wholesale');
    }),
  );
  it.effect('refuses an alias in another Tenant, issuer, namespace or logical source route', () =>
    Effect.gen(function* foreignQualifications() {
      const decoded = yield* decodeSymmySourceSelector(encodeSymmySourceSelector(scope, 'same-key', targetResourceId));
      for (const other of [
        { ...scope, tenantId: '20000000-0000-4000-8000-000000000002' },
        { ...scope, issuerId: 'other-issuer' },
        { ...scope, sourceNamespace: 'other-namespace' },
        { ...scope, sourceRouteId: 'other-logical-route' },
        { ...scope, selectorKind: 'CUSTOMER_GROUP' as const },
      ]) {
        const error = yield* verifySymmySourceSelector(decoded, other, 'same-key', targetResourceId).pipe(Effect.flip);
        expect(Schema.is(SymmySourceSelectorError)(error)).toBe(true);
        expect(error.reason).toBe('source_scope_mismatch');
      }
      expect(
        encodeSymmySourceSelector({ ...scope, issuerId: 'a', sourceNamespace: 'bc' }, 'key', targetResourceId),
      ).not.toBe(
        encodeSymmySourceSelector({ ...scope, issuerId: 'ab', sourceNamespace: 'c' }, 'key', targetResourceId),
      );
    }),
  );
  it.effect('rejects a well-formed forged digest and a substituted target hint through native verification', () =>
    Effect.gen(function* forgedQualifiedSelectors() {
      const valid = encodeSymmySourceSelector(scope, 'actual-source-key', targetResourceId);
      const digest = yield* Effect.fromNullishOr(valid.split('.')[1]).pipe(Effect.orDie);
      const changedDigest = `${digest.startsWith('A') ? 'B' : 'A'}${digest.slice(1)}`;
      for (const code of [
        valid.replace(digest, changedDigest),
        valid.replace(targetResourceId, '30000000-0000-4000-8000-00000000000b'),
      ]) {
        expect(Schema.is(SymmySelectedSourceCodeSchema)(code)).toBe(true);
        const decoded = yield* decodeSymmySourceSelector(code);
        const failure = yield* verifySymmySourceSelector(decoded, scope, 'actual-source-key', targetResourceId).pipe(
          Effect.flip,
        );
        expect(Schema.is(SymmySourceSelectorError)(failure)).toBe(true);
        expect(failure.reason).toBe('source_scope_mismatch');
      }
    }),
  );
  it.effect('rejects malformed versions, hashes and target hints before any metadata lookup', () =>
    Effect.gen(function* invalidRepresentations() {
      const valid = encodeSymmySourceSelector(scope, 'f', targetResourceId);
      const [prefix, hash] = valid.split('.');
      for (const code of [
        `${prefix}.short.${targetResourceId}`,
        `${prefix}.${hash}.not-a-uuid`,
        `${prefix}.${hash}.${targetResourceId.toUpperCase()}`,
        `${prefix}.${hash}=.${targetResourceId}`,
        `~c14s2.${hash}.${targetResourceId}`,
      ]) {
        expect(Schema.is(SymmySourceSelectorError)(yield* decodeSymmySourceSelector(code).pipe(Effect.flip))).toBe(
          true,
        );
      }
      const decoded = yield* decodeSymmySourceSelector(valid);
      expect(
        Schema.is(SymmySourceSelectorError)(
          yield* verifySymmySourceSelector(decoded, scope, 'different-source-key', targetResourceId).pipe(Effect.flip),
        ),
      ).toBe(true);
      expect(
        Schema.is(SymmySourceSelectorError)(
          yield* verifySymmySourceSelector(decoded, scope, 'f', '30000000-0000-4000-8000-00000000000b').pipe(
            Effect.flip,
          ),
        ),
      ).toBe(true);
    }),
  );
  it.effect('preserves the existing short raw-code contract as issuer-scoped legacy input', () =>
    Effect.gen(function* legacySelectors() {
      const decoded = yield* decodeSymmySourceSelector('existing.code-01');
      expect(Schema.is(Schema.TaggedStruct('Legacy', { code: Schema.String }))(decoded)).toBe(true);
      expect(yield* verifySymmySourceSelector(decoded, scope, 'separate-source-id', targetResourceId)).toBe(
        'existing.code-01',
      );
    }),
  );
});
