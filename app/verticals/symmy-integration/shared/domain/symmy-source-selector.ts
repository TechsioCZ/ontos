import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Effect, Match, Schema } from 'effect';
import { Base64Url } from 'effect/encoding';

const legacyCode = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9._-]{1,80}$/u));
const targetHint = Schema.String.check(Schema.isUUID(), Schema.isPattern(/^[0-9a-f-]{36}$/u)).pipe(
  Schema.brand('SymmySourceTargetHint'),
  Schema.decodeTo(Schema.String),
);
const sourceHash = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{43}$/u));
const selectorParts = Schema.Tuple([Schema.Literal('~c14s1'), sourceHash, targetHint]);

/** An 87-character unreserved segment stays within the native router's parameter limit. */
export const SymmyEncodedSourceCodeSchema = Schema.String.check(
  Schema.isPattern(/^~c14s1\.[a-zA-Z0-9_-]{43}\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u),
).pipe(Schema.brand('SymmyEncodedSourceCode'));
export const SymmySelectedSourceCodeSchema = Schema.Union([legacyCode, Schema.toEncoded(SymmyEncodedSourceCodeSchema)]);
export const SymmyDecodedSourceSelectorSchema = Schema.Union([
  Schema.TaggedStruct('Legacy', { code: legacyCode }),
  Schema.TaggedStruct('Qualified', {
    code: Schema.toEncoded(SymmyEncodedSourceCodeSchema),
    targetResourceId: targetHint,
  }),
]);
export type SymmyDecodedSourceSelector = typeof SymmyDecodedSourceSelectorSchema.Type;

export interface SymmySourceSelectorScope {
  readonly issuerId: string;
  readonly routeId: string;
  readonly selectorKind: 'PRICE_GROUP' | 'CUSTOMER_GROUP';
  readonly sourceNamespace: string;
  readonly sourceRouteId?: string;
  readonly tenantId: string;
}
export class SymmySourceSelectorError extends Schema.TaggedError<SymmySourceSelectorError>()(
  'SymmySourceSelectorError',
  { reason: Schema.Literals(['invalid_selector', 'source_scope_mismatch']) },
) {}

const qualifiedSourceHash = (scope: SymmySourceSelectorScope, sourceRecordId: string): string => {
  const route = scope.sourceRouteId ?? scope.routeId;
  // Length prefixes prevent delimiter collisions; physical rows and mapping revisions are not identities.
  const value = `${scope.tenantId.length}:${scope.tenantId}${scope.issuerId.length}:${scope.issuerId}${scope.sourceNamespace.length}:${scope.sourceNamespace}${route.length}:${route}${scope.selectorKind.length}:${scope.selectorKind}${sourceRecordId.length}:${sourceRecordId}`;
  return Base64Url.encode(sha256(utf8ToBytes(value)));
};

/**
 * The UUID is only a bounded lookup hint into existing operator selector metadata. It never replaces
 * the source key or grants authority; the complete qualified source hash and actual owner binding
 * must both match before a selected operation can use the metadata's retained original source key.
 */
export const encodeSymmySourceSelector = (
  scope: SymmySourceSelectorScope,
  sourceRecordId: string,
  targetResourceId: string,
): string => `~c14s1.${qualifiedSourceHash(scope, sourceRecordId)}.${targetResourceId}`;

export const decodeSymmySourceSelector = Effect.fn('SymmySourceSelector.decode')(function* decode(code: string) {
  yield* Schema.decodeUnknownEffect(SymmySelectedSourceCodeSchema)(code).pipe(
    Effect.catchTag('SchemaError', () => Effect.fail(new SymmySourceSelectorError({ reason: 'invalid_selector' }))),
  );
  if (!code.startsWith('~c14s1.')) {
    return { _tag: 'Legacy', code } satisfies SymmyDecodedSourceSelector;
  }
  const parts = yield* Schema.decodeUnknownEffect(selectorParts)(code.split('.')).pipe(
    Effect.catchTag('SchemaError', () => Effect.fail(new SymmySourceSelectorError({ reason: 'invalid_selector' }))),
  );
  return { _tag: 'Qualified', code, targetResourceId: parts[2] } satisfies SymmyDecodedSourceSelector;
});

export const verifySymmySourceSelector = (
  selector: SymmyDecodedSourceSelector,
  scope: SymmySourceSelectorScope,
  sourceRecordId: string,
  targetResourceId: string,
): Effect.Effect<string, SymmySourceSelectorError> =>
  Match.value(selector).pipe(
    Match.tag('Legacy', ({ code }) => Effect.succeed(code)),
    Match.tag('Qualified', (qualified) =>
      qualified.targetResourceId === targetResourceId &&
      qualified.code === encodeSymmySourceSelector(scope, sourceRecordId, targetResourceId)
        ? Effect.succeed(sourceRecordId)
        : Effect.fail(new SymmySourceSelectorError({ reason: 'source_scope_mismatch' })),
    ),
    Match.exhaustive,
  );
