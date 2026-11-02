import { fileURLToPath } from 'node:url';

import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { CatalogRevisionNumberSchema } from '@app/catalog/domain/catalog-revision-reference';
import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { AttributeDefinitionRefSchema } from '@app/catalog/resources/attribute-definition';
import { ProductUnitRefSchema } from '@app/catalog/resources/product-unit';
import { executeRetireVariantWithAuthorization } from '@app/catalog/api/client';
import {
  EXTERNAL_GATEWAY_ASSERTION_VERSION,
  GATEWAY_ASSERTION_TTL_SECONDS,
  decodeSupportedGatewayContextClaims,
  SupportedGatewayContextClaimsSchema,
} from '@app/shared-contracts';
import {
  PricingCurrencySupportGenerationSchema,
  PricingCurrencySupportScheduleRevisionSchema,
  PricingCurrencySupportRootRefSchema,
  PricingCurrencySupportRevisionRefSchema,
  PricingInstantSchema,
  PricingRevisionSchema,
} from '@app/pricing-contracts/domain/currency-support';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { ChildProcess } from 'effect/process';
import { FetchHttpClient } from 'effect/http';
import { Crypto, DateTime, Effect, FileSystem, Layer, Option, Redacted, Schema, Stream } from 'effect';
import { assert, expect, it } from 'effect-rstest';

import { catalogSelectionAssessmentPortFromEnvironment } from '../../src/integrations/catalog-selection-evidence.ts';
import {
  PricingCatalogSelectionUnavailable,
  CatalogSelectionGatewayCredentialService,
} from '../../shared/domain/catalog-selection-gateway-credential.ts';
import { PricingCommercialContextUnavailable } from '../../shared/domain/pricing-commercial-context-unavailable.ts';
import { applyPriceDefinition, DefinePricePayloadSchema } from '../../src/actions/define-price.action.ts';
import type { DefinePriceActionServices } from '../../src/actions/define-price.action.ts';
import { preparePriceSourceEvidence } from '../../src/services/price-source-provenance.service.ts';

const ReceiverReadySchema = Schema.Struct({
  actor: TrustedPrincipalContextSchema,
  alternate: CatalogSelectionSchema,
  attributeDefinitionRef: AttributeDefinitionRefSchema,
  buildMarker: Schema.String,
  compositionRevision: Schema.String,
  definitionRevision: CatalogRevisionNumberSchema,
  legalEntityId: Schema.String.check(Schema.isUUID()).pipe(Schema.brand('LegalEntityId')),
  observedAt: Schema.DateTimeUtcFromString,
  otherSelection: CatalogSelectionSchema,
  port: Schema.Int,
  selected: CatalogSelectionSchema,
  type: Schema.Literal('ready'),
  unitRef: ProductUnitRefSchema,
});
class CatalogRetiredReceiverUnavailable extends Schema.TaggedError<CatalogRetiredReceiverUnavailable>()(
  'CatalogRetiredReceiverUnavailable',
  {
    reason: Schema.String,
  },
) {}
const appRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const services = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);

it.layer(services, { excludeTestServices: true })((suite) =>
  suite.effect(
    'Pricing consumes healthy sibling Current evidence after actual Catalog retirement and rejects the retired Variant',
    () =>
      Effect.gen(function* catalogRetiredConsumer() {
        const directory = fileURLToPath(new URL('../../../catalog/node_modules/.cache/ontos-1252/', import.meta.url));
        const artifact = `${directory}${yield* nextId}.mjs`;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* Effect.addFinalizer(() => fs.remove(artifact, { force: true }).pipe(Effect.orDie));
        // This is a Catalog-owned process entry, never a private import into Pricing.
        const bundle = yield* ChildProcess.make(
          'mise',
          [
            'exec',
            '--',
            'pnpm',
            'exec',
            'esbuild',
            'verticals/catalog/tests/support/retired-sibling-receiver.fixture.ts',
            '--bundle',
            '--platform=node',
            '--format=esm',
            '--packages=external',
            `--outfile=${artifact}`,
          ],
          { cwd: appRoot, stderr: 'pipe', stdout: 'pipe' },
        );
        const [bundleExit] = yield* Effect.all(
          [bundle.exitCode, Stream.runDrain(bundle.stdout), Stream.runDrain(bundle.stderr)],
          { concurrency: 3 },
        );
        expect(bundleExit).toBe(0);
        const keys = yield* Effect.tryPromise({
          catch: () => new CatalogRetiredReceiverUnavailable({ reason: 'Test signing key generation failed' }),
          try: () => globalThis.crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']),
        });
        assert('privateKey' in keys);
        const publicKey = yield* Effect.tryPromise({
          catch: () => new CatalogRetiredReceiverUnavailable({ reason: 'Test public verification key export failed' }),
          try: () => globalThis.crypto.subtle.exportKey('jwk', keys.publicKey),
        });
        const issuer = 'https://pricing-catalog-retired.test';
        const kid = 'pricing-catalog-retired';
        const publicJwkSchema = Schema.Struct({
          crv: Schema.Literal('Ed25519'),
          kty: Schema.Literal('OKP'),
          x: Schema.String,
        });
        const publicJwk = yield* Schema.decodeUnknownEffect(publicJwkSchema)(publicKey);
        const jwksSchema = Schema.Struct({
          keys: Schema.Array(
            Schema.Struct({
              ...publicJwkSchema.fields,
              alg: Schema.Literal('EdDSA'),
              kid: Schema.String,
              use: Schema.Literal('sig'),
            }),
          ),
        });
        const jwks = yield* Schema.encodeEffect(Schema.fromJsonString(jwksSchema))({
          keys: [{ ...publicJwk, alg: 'EdDSA', kid, use: 'sig' }],
        });
        const child = yield* ChildProcess.make(process.execPath, [artifact, '--serve-retired-sibling'], {
          cwd: appRoot,
          env: { ONTOS_TEST_CATALOG_RETIRED_ISSUER: issuer, ONTOS_TEST_CATALOG_RETIRED_JWKS: jwks },
          extendEnv: true,
          stderr: 'pipe',
          stdout: 'pipe',
        });
        yield* Stream.runDrain(child.stderr).pipe(Effect.forkScoped);
        const line = yield* Effect.raceFirst(
          child.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runHead),
          child.exitCode.pipe(
            Effect.flatMap(() =>
              Effect.fail(
                new CatalogRetiredReceiverUnavailable({ reason: 'Catalog receiver exited before readiness' }),
              ),
            ),
          ),
        );
        if (Option.isNone(line)) {
          return yield* new CatalogRetiredReceiverUnavailable({ reason: 'Catalog receiver readiness was absent' });
        }
        const ready = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReceiverReadySchema))(line.value);
        const baseUrl = new URL(`http://127.0.0.1:${ready.port}`);
        const signingCrypto = yield* Crypto.Crypto;
        const authorization = Effect.fn('CatalogRetiredConsumer.authorization')(function* authorization() {
          const now = Math.floor(DateTime.toEpochMillis(ready.observedAt) / 1000);
          const headerSchema = Schema.Struct({
            alg: Schema.Literal('EdDSA'),
            kid: Schema.String,
            typ: Schema.Literal('JWT'),
          });
          const header = Buffer.from(
            yield* Schema.encodeEffect(Schema.fromJsonString(headerSchema))({ alg: 'EdDSA', kid, typ: 'JWT' }),
          ).toString('base64url');
          const claims = yield* decodeSupportedGatewayContextClaims({
            aud: 'catalog',
            compositionRevision: ready.compositionRevision,
            exp: now + GATEWAY_ASSERTION_TTL_SECONDS,
            iat: now,
            iss: issuer,
            jti: yield* signingCrypto.randomUUIDv4(),
            principal: ready.actor,
            sub: ready.actor.principalId,
            targetBuildMarker: ready.buildMarker,
            ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
          });
          const payload = Buffer.from(
            yield* Schema.encodeEffect(Schema.fromJsonString(SupportedGatewayContextClaimsSchema))(claims),
          ).toString('base64url');
          const content = `${header}.${payload}`;
          const signature = yield* Effect.tryPromise({
            catch: () => new CatalogRetiredReceiverUnavailable({ reason: 'Test assertion signing failed' }),
            try: () => globalThis.crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(content)),
          });
          return `Bearer ${content}.${Buffer.from(signature).toString('base64url')}`;
        });
        let credentials = 0;
        const port = yield* catalogSelectionAssessmentPortFromEnvironment({
          compositionRevision: ready.compositionRevision,
          legalEntityId: ready.legalEntityId,
          requestCorrelation: yield* nextId,
        }).pipe(
          Effect.provideService(CatalogSelectionGatewayCredentialService, {
            issue: (request) =>
              Effect.gen(function* issueCatalogOnlyTestCredential() {
                expect(request.audience).toBe('catalog');
                expect(request.compositionRevision).toBe(ready.compositionRevision);
                credentials += 1;
                // Catalog selection-evidence is tenant-only: the test assertion contains no LE.
                return { baseUrl, credential: Redacted.make(yield* authorization()) };
              }).pipe(
                Effect.mapError(
                  () =>
                    new PricingCatalogSelectionUnavailable({
                      code: 'pricing_catalog_selection_unavailable',
                      reason: 'Fixture assertion issuance failed',
                      retryable: true,
                    }),
                ),
              ),
          }),
        );
        const healthy = yield* port.assess(ready.alternate);
        expect(healthy).toMatchObject({ purpose: 'PRICING', selection: ready.alternate, status: 'VALID' });
        const at = yield* Schema.decodeUnknownEffect(PricingInstantSchema)(DateTime.formatIso(ready.observedAt));
        const { tenantId } = ready.actor;
        const root = yield* Schema.decodeUnknownEffect(PricingCurrencySupportRootRefSchema)({
          moduleId: 'commerce.pricing',
          resourceId: yield* nextId,
          resourceType: 'commerce.pricing.currency-support',
          tenantId,
        });
        const revision = yield* Schema.decodeUnknownEffect(PricingCurrencySupportRevisionRefSchema)({
          moduleId: 'commerce.pricing',
          resourceId: yield* nextId,
          resourceType: 'commerce.pricing.currency-support-revision',
          supportRootId: root.resourceId,
          tenantId,
        });
        const generation = yield* Schema.decodeUnknownEffect(PricingCurrencySupportGenerationSchema)(1);
        const scheduleRevision = yield* Schema.decodeUnknownEffect(PricingCurrencySupportScheduleRevisionSchema)(1);
        const pricingRevision = yield* Schema.decodeUnknownEffect(PricingRevisionSchema)('test-currency-port:1');
        const currencyPort = {
          currentnessEvidence: {
            evaluatedAt: at,
            evaluationMode: 'CURRENT_WITH_REVALIDATION' as const,
            observedAt: at,
            revalidatedAt: at,
            scheduleRevision,
            supportRevisionRef: revision,
            supportRootRef: root,
          },
          effectivePeriod: { effectiveFrom: at, effectiveTo: null },
          generation,
          observedAt: at,
          pricingRevision,
          scheduleRevision,
          supportedCurrencies: ['CZK'] as const,
          supportRevisionRef: revision,
          supportRootRef: root,
        };
        const unitBasis = { quantity: '1', unitRef: ready.unitRef };
        const monetaryAmount = { amount: '100', currencyCode: 'CZK' };
        const payload = yield* Schema.decodeUnknownEffect(DefinePricePayloadSchema)({
          effectiveFrom: at,
          identityKey: {
            catalogSelection: ready.alternate,
            commercialScope: {
              channelId: 'B2C',
              marketId: 'test-market-port',
              sellingLegalEntityId: ready.legalEntityId,
            },
            currencyCode: 'CZK',
            priceGroupSelector: { kind: 'NO_GROUP' },
            unitBasis,
          },
          monetaryAmount,
          priceRef: {
            moduleId: 'commerce.pricing',
            resourceId: yield* nextId,
            resourceType: 'commerce.pricing.price',
            tenantId,
          },
          reason: 'Exercise the actual Catalog selection admission guard',
          sourceAssertion: {
            lineage: { kind: 'INITIAL' },
            mapping: { mappingContractRef: 'test-owner-source-port', mappingContractVersion: '1' },
            originalAssertion: { monetaryAmount, monetaryBoundary: 'PRE_TAX', unitBasis },
            sourceAssertionId: yield* nextId,
            sourceAuthority: { sourceAuthorityRef: 'test-source-authority-port', sourceAuthorityVersion: '1' },
            sourceRecord: {
              sourceChangeCorrelation: 'test-change',
              sourceRecordRef: 'test-record',
              sourceRecordVersion: '1',
              sourceSystem: { ownerModuleId: 'commerce.pricing', sourceSystemRef: 'test-system' },
            },
            timing: { importedAt: at, ownerBusinessEffectiveAt: at, sourceEffectiveAt: at },
          },
        });
        let marketCalls = 0;
        let persistenceCalls = 0;
        const guardServices: DefinePriceActionServices = {
          assessCatalogSelection: port.assess,
          // Explicit prerequisite test ports, not native Currency/External Source authority proof.
          assessCommercialContext: () => {
            marketCalls += 1;
            return Effect.fail(
              new PricingCommercialContextUnavailable({
                code: 'pricing_commercial_context_unavailable',
                reason: 'Deliberately unavailable downstream Market test port',
                retryable: true,
              }),
            );
          },
          assessExternalPriceInput: (request) => Effect.succeed(preparePriceSourceEvidence(request)),
          define: () => {
            persistenceCalls += 1;
            return Effect.die('A Price write must not be reached in this guard test');
          },
          loadCurrencySupport: () => Effect.succeed({ _tag: 'current' as const, current: currencyPort }),
        };
        const trusted = {
          actingPrincipalId: ready.actor.principalId,
          actionInvocationId: yield* nextId,
          legalEntityId: ready.legalEntityId,
          requestCorrelationId: yield* nextId,
          tenantId,
          trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe(at)),
        };
        expect(yield* applyPriceDefinition(payload, trusted, guardServices)).toMatchObject({
          dependency: 'COMMERCE_MARKET_CATALOG',
          outcome: 'PRICE_SOURCE_ASSERTION_DEPENDENCY_UNAVAILABLE',
        });
        expect(marketCalls).toBe(1);
        expect(persistenceCalls).toBe(0);
        expect(
          yield* executeRetireVariantWithAuthorization(
            {
              expectedVariantRevision: 2,
              reason: 'Retire only the first Variant while preserving its retained direct attributes',
              variantRef: ready.selected.variantRef,
            },
            yield* authorization(),
            yield* nextId,
            { baseUrl, compositionRevision: ready.compositionRevision, idempotencyKey: yield* nextId },
          ),
        ).toMatchObject({ variant: { lifecycle: 'RETIRED', variantRef: ready.selected.variantRef } });
        const revoked = yield* port.assess(ready.selected);
        expect(revoked).toMatchObject({ purpose: 'PRICING', selection: ready.selected, status: 'INVALID' });
        // V2 still passes the actual DefinePrice Catalog guard and reaches only the explicit unavailable Market prerequisite.
        expect(yield* applyPriceDefinition(payload, trusted, guardServices)).toMatchObject({
          dependency: 'COMMERCE_MARKET_CATALOG',
          outcome: 'PRICE_SOURCE_ASSERTION_DEPENDENCY_UNAVAILABLE',
        });
        expect(marketCalls).toBe(2);
        const retiredPayload = {
          ...payload,
          identityKey: { ...payload.identityKey, catalogSelection: ready.selected },
        };
        expect(yield* applyPriceDefinition(retiredPayload, trusted, guardServices)).toMatchObject({
          outcome: 'PRICE_SOURCE_ASSERTION_KNOWN_INVALID',
        });
        expect(marketCalls).toBe(2);
        expect(persistenceCalls).toBe(0);
        expect(yield* port.assess(ready.alternate)).toMatchObject({ status: 'VALID' });
        expect(yield* port.assess(ready.otherSelection)).toMatchObject({ status: 'VALID' });
        expect(credentials).toBe(7);
        return yield* Effect.void;
      }).pipe(Effect.scoped),
    120_000,
  ),
);
