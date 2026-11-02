import { ActiveApplicationCompositionService } from '@app/core-runtime/modules/active-application-composition';
import {
  OpenSelectionPopulationEntrySchema,
  OpenSelectionPopulationRequestSchema,
  OpenSelectionPopulationResponseSchema,
} from '@app/commerce-cart-contracts/open-selection-population';
import { executeOpenSelectionPopulationWithAuthorization } from '@app/commerce-cart-contracts/open-selection-population/client';
import { issueApiKeyGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import { Config, Crypto, DateTime, Effect, Layer, Schema } from 'effect';

import {
  CartOpenSelectionPopulationEvidenceSchema,
  CartOpenSelectionPopulationUnavailable,
} from '../shared/domain/catalog-open-selection-population.ts';
import { CartOpenSelectionPopulationService } from '../shared/domain/cart-open-selection-population-service.ts';

const serviceOrigin = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.pathname === '/' &&
    url.search.length === 0 &&
    url.hash.length === 0
      ? undefined
      : 'Service destination must be an HTTP(S) origin without credentials, path, query or fragment',
  ),
);

// Shell publishes its API-key issuance under its BFF prefix; the configured binding names only the origin.
const SHELL_API_PREFIX = '/shell-super-app-api';

const unavailable = (reason: string) =>
  new CartOpenSelectionPopulationUnavailable({ code: 'cart_open_selection_population_unavailable', reason });

/** Keeps the underlying failure on a non-enumerable `cause` so it is never serialized to callers. */
const unavailableBecause = (reason: string) => (cause: unknown) =>
  Object.defineProperty(unavailable(reason), 'cause', { value: cause });

/** Trusted deployment bindings are separate for each Tenant, never one cross-Tenant API key. */
const tenantBinding = (tenantId: string) => {
  const prefix = `ONTOS_CATALOG_CART_POPULATION_${tenantId.replaceAll('-', '').toUpperCase()}`;
  return Config.all({
    apiKey: Config.Redacted(`${prefix}_GATEWAY_API_KEY`),
    cartBaseUrl: Config.schema(serviceOrigin, `${prefix}_OWNER_ORIGIN`),
    shellBaseUrl: Config.schema(serviceOrigin, `${prefix}_SHELL_ORIGIN`),
  });
};

const hexadecimalDigest = (bytes: Uint8Array) =>
  Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');

/**
 * The production bridge calls the published Cart client with a fresh, tenant-bound Shell
 * assertion for each read. Configuration, composition and owner health are consulted lazily,
 * so an unavailable Cart cannot prevent unrelated Catalog operations from starting.
 */
export const cartOpenSelectionPopulationLive = Layer.effect(
  CartOpenSelectionPopulationService,
  Effect.gen(function* makeCartOpenSelectionPopulation() {
    const composition = yield* ActiveApplicationCompositionService;
    const crypto = yield* Crypto.Crypto;
    return {
      read: Effect.fn('CatalogCartOpenSelectionPopulation.read')(function* read(input: { readonly tenantId: string }) {
        const payload = yield* Schema.decodeUnknownEffect(OpenSelectionPopulationRequestSchema)(input).pipe(
          Effect.mapError(unavailableBecause('The requested Cart population Tenant is invalid')),
        );
        const binding = yield* tenantBinding(payload.tenantId).pipe(
          Effect.mapError(unavailableBecause('The Tenant Cart population service binding is unavailable')),
        );
        const snapshot = yield* composition.load.pipe(
          Effect.mapError(unavailableBecause('The active Cart population composition is unavailable')),
        );
        const requestCorrelation = yield* crypto
          .randomUUIDv4()
          .pipe(Effect.mapError(unavailableBecause('The Cart population request identity is unavailable')));
        // This Tenant-wide read forbids Legal Entity scope. Shell resolves the key's actual
        // Principal/Tenant; the receiving owner independently authorizes the same request Tenant.
        const credential = yield* issueApiKeyGatewayContext(
          { audience: 'commerce-cart', compositionRevision: snapshot.composition.revision },
          { apiKey: binding.apiKey, baseUrl: new URL(SHELL_API_PREFIX, binding.shellBaseUrl), requestCorrelation },
        ).pipe(Effect.mapError(unavailableBecause('The Cart population gateway credential could not be issued')));
        // Shell dispatches every non-Shell owner through its approved module-release route.
        if (
          credential.compositionRevision !== snapshot.composition.revision ||
          !/^\/shell-super-app-api\/module-api\/commerce-cart\/[^/]+\/commerce-cart-api$/u.test(credential.apiBaseUrl)
        ) {
          return yield* unavailable('The Cart population credential does not name the expected owner and composition');
        }
        const response = yield* executeOpenSelectionPopulationWithAuthorization(
          payload,
          `Bearer ${credential.token}`,
          requestCorrelation,
          {
            baseUrl: new URL(credential.apiBaseUrl, binding.shellBaseUrl),
            compositionRevision: snapshot.composition.revision,
          },
        ).pipe(Effect.mapError(unavailableBecause('The authoritative Cart population read is unavailable')));
        const population = yield* Schema.decodeUnknownEffect(Schema.toType(OpenSelectionPopulationResponseSchema), {
          onExcessProperty: 'error',
        })(response).pipe(Effect.mapError(unavailableBecause('The Cart owner returned an invalid population')));
        if (population.tenantId !== payload.tenantId) {
          return yield* unavailable('The Cart owner returned a population for a different Tenant');
        }
        const canonical = yield* Schema.encodeEffect(
          Schema.fromJsonString(Schema.Array(OpenSelectionPopulationEntrySchema)),
        )(population.entries).pipe(Effect.mapError(unavailableBecause('The Cart population material is invalid')));
        const bytes = new TextEncoder().encode(canonical);
        if (bytes.length > 2_097_152) {
          return yield* unavailable('The Cart population exceeds its declared V1 material limit');
        }
        const hashed = yield* crypto
          .digest('SHA-256', bytes)
          .pipe(Effect.mapError(unavailableBecause('The Cart population material could not be verified')));
        const digest = hexadecimalDigest(new Uint8Array(hashed));
        if (
          population.digest !== digest ||
          population.revisionToken !== `cart:v1:${payload.tenantId}:${population.generation}:${digest}`
        ) {
          return yield* unavailable('The Cart population token does not bind its complete owner material');
        }
        return yield* Schema.decodeUnknownEffect(CartOpenSelectionPopulationEvidenceSchema)({
          complete: population.complete,
          observedAt: DateTime.formatIso(population.observedAt),
          revisionToken: population.revisionToken,
          selections: population.entries.map(({ selection, selectionId }) => ({ selection, selectionId })),
          tenantId: population.tenantId,
        }).pipe(
          Effect.mapError(unavailableBecause('The Cart population cannot be represented by the Catalog contract')),
        );
      }),
    };
  }),
);
