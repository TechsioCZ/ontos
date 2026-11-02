#!/usr/bin/env node
/**
 * E-shop markets demo seed over the public Shell, as each company's e-shop administrator (`--mode dry-run|apply|verify`).
 *
 * Only governed reads and Actions: Storefront Registry registrations, Market creation and storefront associations
 * (commerce.market-catalog), and the merchandise Market settings and product offer exceptions. Existing records are
 * kept; the seed only adds what is missing, so reruns are safe.
 */
import { NodeServices } from '@effect/platform-node';
import { Config, Console, DateTime, Duration, Effect, Exit, Layer, Option, Schedule, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { FetchHttpClient } from 'effect/http';

import {
  AssociateStorefrontPayloadSchema,
  CreateMarketPayloadSchema,
  CreateMarketResultSchema,
  StorefrontAssociationResultSchema,
} from '../../verticals/commerce-market-catalog/shared/action-contracts.ts';
import {
  CurrentMarketCatalogRequestSchema,
  CurrentMarketCatalogResponseSchema,
} from '../../verticals/commerce-market-catalog/shared/apis/current-market-catalog.ts';
import type {
  InitialMarketLifecycleSchema,
  JurisdictionRefSchema,
  MarketChannelSchema,
} from '../../verticals/commerce-market-catalog/shared/market-contracts.ts';
import { MerchandiseCommandSchema } from '../../verticals/merchandise/shared/actions/apply-command.ts';
import { RecordsRequestSchema, RecordsResponseSchema } from '../../verticals/merchandise/shared/apis/records.ts';
import type { MarketCurrency, MarketOfferMode } from '../../verticals/merchandise/shared/domain/market-offers.ts';
import {
  RegisterStorefrontApplicationPayloadSchema,
  RegisterStorefrontApplicationResultSchema,
} from '../../verticals/storefront-registry/shared/actions/register-storefront-application.ts';
import {
  StorefrontApplicationsRequestSchema,
  StorefrontApplicationsResponseSchema,
} from '../../verticals/storefront-registry/shared/apis/storefront-applications.ts';
import { akrosDemoLegalEntityId, demoId, demoTenantId, eshopDemoLegalEntityId } from './fixture-ids.mts';
import { connectSeedClient, DemoSeedError } from './seed-client.mts';
import type { SeedClient } from './seed-client.mts';

const modes = ['dry-run', 'apply', 'verify'] as const;
type Mode = (typeof modes)[number];
const effectiveFrom = '2026-10-01T00:00:00.000Z';
const provenance = { kind: 'CONFIGURATION_ACTION', reference: 'seed-eshop-markets:v1' } as const;
const marketAudience = 'commerce-market-catalog';
const registryAudience = 'storefront-registry';
const merchandiseAudience = 'merchandise';
const akrosStorefront = 'akros-storefront';

type Channel = typeof MarketChannelSchema.Type;
interface MarketSeed {
  readonly channel: Channel;
  readonly code: string;
  readonly currency: MarketCurrency;
  readonly exchangeRate: string;
  readonly jurisdiction: typeof JurisdictionRefSchema.Type;
  readonly key: string;
  readonly lifecycle: typeof InitialMarketLifecycleSchema.Type;
  readonly locale: string;
  readonly offerMode: MarketOfferMode;
  readonly purpose: string;
  readonly roundingMinor: number;
  readonly storefrontAppId: string;
}
interface CompanySeed {
  readonly email: string;
  readonly legalEntityId: string;
  readonly markets: readonly MarketSeed[];
  readonly storefront: Readonly<{ appId: string; channels: readonly Channel[] }>;
}

const market = (seed: Omit<MarketSeed, 'storefrontAppId'>, storefrontAppId: string): MarketSeed => ({
  ...seed,
  storefrontAppId,
});

export const eshopMarketSeed: readonly CompanySeed[] = [
  {
    email: 'eshop@akros.demo',
    legalEntityId: akrosDemoLegalEntityId,
    markets: [
      market(
        {
          channel: 'B2C',
          code: 'AKROS-CZ',
          currency: 'CZK',
          exchangeRate: '1',
          jurisdiction: { code: 'CZ', kind: 'COUNTRY' },
          key: 'akros-cz',
          lifecycle: 'ACTIVE',
          locale: 'cs',
          offerMode: 'WHOLE_CATALOGUE',
          purpose: 'Maloobchodní prodej v Česku',
          roundingMinor: 100,
        },
        akrosStorefront,
      ),
      market(
        {
          channel: 'B2C',
          code: 'AKROS-SK',
          currency: 'EUR',
          exchangeRate: '0.04',
          jurisdiction: { code: 'SK', kind: 'COUNTRY' },
          key: 'akros-sk',
          lifecycle: 'ACTIVE',
          locale: 'sk',
          offerMode: 'WHOLE_CATALOGUE',
          purpose: 'Maloobchodní prodej na Slovensku',
          roundingMinor: 10,
        },
        akrosStorefront,
      ),
      market(
        {
          channel: 'B2C',
          code: 'AKROS-EU',
          currency: 'EUR',
          exchangeRate: '0.041',
          jurisdiction: { code: 'EU', kind: 'REGION' },
          key: 'akros-eu',
          lifecycle: 'ACTIVE',
          locale: 'en',
          offerMode: 'WHOLE_CATALOGUE',
          purpose: 'Export do zemí EU v angličtině',
          roundingMinor: 10,
        },
        akrosStorefront,
      ),
      market(
        {
          channel: 'B2B',
          code: 'AKROS-CZ-B2B',
          currency: 'CZK',
          exchangeRate: '0.92',
          jurisdiction: { code: 'CZ', kind: 'COUNTRY' },
          key: 'akros-cz-b2b',
          lifecycle: 'ACTIVE',
          locale: 'cs',
          offerMode: 'WHOLE_CATALOGUE',
          purpose: 'Velkoobchod pro firemní zákazníky v Česku',
          roundingMinor: 100,
        },
        akrosStorefront,
      ),
      market(
        {
          channel: 'B2C',
          code: 'AKROS-PL',
          currency: 'PLN',
          exchangeRate: '0.17',
          jurisdiction: { code: 'PL', kind: 'COUNTRY' },
          key: 'akros-pl',
          lifecycle: 'SUSPENDED',
          locale: 'pl',
          offerMode: 'SELECTED_PRODUCTS',
          purpose: 'Příprava vstupu na polský trh',
          roundingMinor: 100,
        },
        akrosStorefront,
      ),
    ],
    storefront: { appId: akrosStorefront, channels: ['B2C', 'B2B'] },
  },
  {
    email: 'eshop@kavarna.demo',
    legalEntityId: eshopDemoLegalEntityId,
    markets: [
      market(
        {
          channel: 'B2C',
          code: 'KAVARNA-CZ',
          currency: 'CZK',
          exchangeRate: '1',
          jurisdiction: { code: 'CZ', kind: 'COUNTRY' },
          key: 'kavarna-cz',
          lifecycle: 'ACTIVE',
          locale: 'cs',
          offerMode: 'WHOLE_CATALOGUE',
          purpose: 'Online prodej kávy v Česku',
          roundingMinor: 100,
        },
        'kavarna-doma-eshop',
      ),
    ],
    storefront: { appId: 'kavarna-doma-eshop', channels: ['B2C'] },
  },
];

export const seededMarketId = (key: string) => demoId('commerce.market-catalog.market', key);
const associationId = (key: string) => demoId('commerce.market-catalog.storefront-association', key);

/** Deterministic AKROS offer exceptions chosen from the sorted published catalogue (indices into it). */
export const akrosOfferPlan = (productIds: readonly string[], featuredIds: readonly string[]) => {
  const featured = featuredIds.find((id) => productIds.includes(id));
  const rest = productIds.filter((id) => id !== featured);
  const czOnly = [...(featured === undefined ? [] : [featured]), ...rest.slice(0, featured === undefined ? 10 : 9)];
  const skOnly = rest.slice(10, 15);
  const notInEu = rest.slice(15, 18);
  const polishLaunch = rest.slice(18, 21);
  return {
    'akros-cz': { notOffered: skOnly, offered: [] },
    'akros-eu': { notOffered: [...czOnly, ...skOnly, ...notInEu], offered: [] },
    'akros-pl': { notOffered: [], offered: polishLaunch },
    'akros-sk': { notOffered: czOnly, offered: [] },
  } as const satisfies Readonly<Record<string, { notOffered: readonly string[]; offered: readonly string[] }>>;
};

const CatalogRequest = Schema.toEncoded(CurrentMarketCatalogRequestSchema);
const CatalogResponse = Schema.toEncoded(CurrentMarketCatalogResponseSchema);
const ApplicationsRequest = Schema.toEncoded(StorefrontApplicationsRequestSchema);
const ApplicationsResponse = Schema.toEncoded(StorefrontApplicationsResponseSchema);
const RecordsRequest = Schema.toEncoded(RecordsRequestSchema);
const Records = Schema.toEncoded(RecordsResponseSchema);
const MerchandiseCommandPayload = Schema.toEncoded(MerchandiseCommandSchema);
type RecordsView = (typeof RecordsRequest.Type)['view'];
type MerchandiseCommand = typeof MerchandiseCommandPayload.Type;
type Catalog = typeof CatalogResponse.Type;

const sellerRef = (legalEntityId: string) => ({
  moduleId: 'core.identity' as const,
  resourceId: legalEntityId,
  resourceType: 'core.identity.legal-entity' as const,
  tenantId: demoTenantId,
});
const marketRef = (marketId: string) => ({
  moduleId: 'commerce.market-catalog' as const,
  resourceId: marketId,
  resourceType: 'commerce.market-catalog.market' as const,
  tenantId: demoTenantId,
});
const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const readCatalog = (client: SeedClient) =>
  nowIso.pipe(
    Effect.flatMap((at) =>
      client.call(marketAudience, '/reads/current-market-catalog', CatalogRequest, { at }, CatalogResponse),
    ),
  );
const readApplications = (client: SeedClient) =>
  nowIso.pipe(
    Effect.flatMap((at) =>
      client.call(
        registryAudience,
        '/reads/storefront-applications',
        ApplicationsRequest,
        { at },
        ApplicationsResponse,
      ),
    ),
  );
const readRecords = (client: SeedClient, view: RecordsView) =>
  client.call(merchandiseAudience, '/reads/records', RecordsRequest, { view }, Records);
const merchandiseCommand = (client: SeedClient, command: MerchandiseCommand) =>
  readRecords(client, { limit: 0, summary: true }).pipe(
    Effect.flatMap(({ revision }) => client.apply(merchandiseAudience, MerchandiseCommandPayload, command, revision)),
  );
const marketAction = <P extends Schema.Top, R extends Schema.Top>(
  client: SeedClient,
  slug: string,
  payloadSchema: P,
  payload: P['Type'],
  resultSchema: R,
) => client.call(marketAudience, `/${marketAudience}/actions/${slug}`, payloadSchema, payload, resultSchema, true);

/** A just-created Market joins its company scope through the Market containment worker; associations wait for it. */
const untilScoped = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
  operation.pipe(
    Effect.retry({
      schedule: Schedule.spaced(Duration.seconds(3)),
      times: 20,
      while: (failure) => Schema.is(DemoSeedError)(failure) && / HTTP 403 /u.test(failure.reason),
    }),
  );

interface Step {
  readonly client: SeedClient;
  readonly company: CompanySeed;
  readonly report: string[];
  readonly write: boolean;
}

const ensureStorefront = ({ client, company, report, write }: Step) =>
  Effect.gen(function* ensureStorefrontApplication() {
    const { applications } = yield* readApplications(client);
    if (applications.some(({ storefrontAppId }) => storefrontAppId === company.storefront.appId)) {
      return;
    }
    report.push(`register ${company.storefront.appId}`);
    if (write) {
      yield* client.call(
        registryAudience,
        `/${registryAudience}/actions/register-storefront-application`,
        Schema.toEncoded(RegisterStorefrontApplicationPayloadSchema),
        {
          allowedChannels: company.storefront.channels,
          effectiveInterval: { effectiveFrom },
          lifecycle: 'ACTIVE',
          reason: 'E-shop markets demo registration',
          storefrontAppId: company.storefront.appId,
        },
        Schema.toEncoded(RegisterStorefrontApplicationResultSchema),
        true,
      );
    }
  });

const ensureMarkets = ({ client, company, report, write }: Step, catalog: Catalog) =>
  Effect.forEach(
    company.markets.filter(
      (seed) => !catalog.markets.some(({ marketRef: ref }) => ref.resourceId === seededMarketId(seed.key)),
    ),
    (seed) => {
      report.push(`create ${seed.code}`);
      return write
        ? marketAction(
            client,
            'create-market',
            Schema.toEncoded(CreateMarketPayloadSchema),
            {
              channels: [seed.channel],
              effectivePeriod: { startsAt: effectiveFrom },
              jurisdictions: [seed.jurisdiction],
              lifecycle: seed.lifecycle,
              marketCode: seed.code,
              marketId: seededMarketId(seed.key),
              purpose: seed.purpose,
              reason: 'E-shop markets demo',
              sellingLegalEntityRef: sellerRef(company.legalEntityId),
              supportedLocales: [seed.locale],
            },
            Schema.toEncoded(CreateMarketResultSchema),
          ).pipe(Effect.asVoid)
        : Effect.void;
    },
    { discard: true },
  );

const ensureAssociations = ({ client, company, report, write }: Step, catalog: Catalog) =>
  Effect.forEach(
    company.markets,
    (seed) => {
      const marketId = seededMarketId(seed.key);
      const definition = catalog.markets.find(({ marketRef: ref }) => ref.resourceId === marketId);
      const associated = catalog.associations.some(
        ({ marketRef: ref, storefrontRef }) =>
          ref.resourceId === marketId && storefrontRef.appId === seed.storefrontAppId,
      );
      if (associated) {
        return Effect.void;
      }
      report.push(`associate ${seed.code} → ${seed.storefrontAppId} (${seed.channel})`);
      return write && definition !== undefined
        ? untilScoped(
            marketAction(
              client,
              'associate-storefront',
              Schema.toEncoded(AssociateStorefrontPayloadSchema),
              {
                associationId: associationId(`${seed.key}:${seed.storefrontAppId}`),
                channel: seed.channel,
                effectivePeriod: { startsAt: effectiveFrom },
                expectedMarketDefinitionRevisionRef: definition.definitionRevisionRef,
                marketRef: marketRef(marketId),
                provenance,
                reason: 'E-shop markets demo association',
                sellingLegalEntityRef: sellerRef(company.legalEntityId),
                storefrontRef: { appId: seed.storefrontAppId, tenantId: demoTenantId },
              },
              Schema.toEncoded(StorefrontAssociationResultSchema),
            ),
          ).pipe(Effect.asVoid)
        : Effect.void;
    },
    { discard: true },
  );

const ensureMarketSettings = ({ client, company, report, write }: Step) =>
  Effect.gen(function* ensureMerchandiseMarkets() {
    const { markets = [] } = yield* readRecords(client, { limit: 0, markets: true, summary: true });
    for (const seed of company.markets) {
      const marketId = seededMarketId(seed.key);
      if (!markets.some((entry) => entry.marketId === marketId)) {
        report.push(`configure ${seed.code} ${seed.offerMode} ${seed.currency}`);
        if (write) {
          yield* merchandiseCommand(client, {
            _tag: 'ConfigureMarket',
            currency: seed.currency,
            exchangeRate: seed.exchangeRate,
            marketCode: seed.code,
            marketId,
            offerMode: seed.offerMode,
            roundingMinor: seed.roundingMinor,
          });
        }
      }
    }
  });

const ensureAkrosOffers = ({ client, report, write }: Step) =>
  Effect.gen(function* ensureAkrosMarketOffers() {
    const listed = yield* readRecords(client, { active: true, limit: 250, productSort: 'sku', summary: true });
    const featured = yield* readRecords(client, {
      storefront: true,
      storefrontCatalog: { featured: true, fields: 'card', includeCategories: false, pageSize: 20 },
    });
    const plan = akrosOfferPlan(
      listed.products.map(({ id }) => id),
      featured.products.map(({ id }) => id),
    );
    const { markets = [] } = yield* readRecords(client, { limit: 0, markets: true, summary: true });
    for (const [key, exceptions] of Object.entries(plan)) {
      const marketId = seededMarketId(key);
      const counts = markets.find((entry) => entry.marketId === marketId)?.exceptionCounts;
      const done =
        counts !== undefined &&
        counts.notOffered >= exceptions.notOffered.length &&
        counts.offered >= exceptions.offered.length;
      if (!done) {
        report.push(`offers ${key}: −${exceptions.notOffered.length} +${exceptions.offered.length}`);
        const batches = [
          { offered: false, productIds: exceptions.notOffered },
          { offered: true, productIds: exceptions.offered },
        ].filter(({ productIds }) => write && productIds.length > 0);
        for (const { offered, productIds } of batches) {
          yield* merchandiseCommand(client, { _tag: 'SetMarketProductOffers', marketId, offered, productIds });
        }
      }
    }
  });

const seedCompany = (company: CompanySeed, mode: Mode) =>
  Effect.gen(function* seedEshopCompany() {
    const password = yield* Config.Redacted('ONTOS_DEMO_SEED_PASSWORD');
    const shellUrl = yield* Config.String('ONTOS_DEMO_SEED_URL');
    const client = yield* Effect.acquireRelease(
      connectSeedClient(
        { legalEntityId: company.legalEntityId, shellUrl, tenantId: demoTenantId },
        company.email,
        password,
      ),
      (session) => session.signOut.pipe(Effect.ignore),
    );
    const step: Step = { client, company, report: [], write: mode === 'apply' };
    yield* ensureStorefront(step);
    yield* ensureMarkets(step, yield* readCatalog(client));
    // Each company's associations are validated through its own Market owner gateway key.
    yield* ensureAssociations(step, yield* readCatalog(client));
    yield* ensureMarketSettings(step);
    if (company.legalEntityId === akrosDemoLegalEntityId) {
      yield* ensureAkrosOffers(step);
    }
    return { company: company.email, pending: step.report };
  }).pipe(Effect.scoped);

const main = (mode: Mode) =>
  Effect.gen(function* seedEshopMarkets() {
    const results = yield* Effect.forEach(eshopMarketSeed, (company) => seedCompany(company, mode), { concurrency: 1 });
    for (const result of results) {
      yield* Console.log(`${result.company}: ${result.pending.length === 0 ? 'complete' : result.pending.join('; ')}`);
    }
    if (mode === 'verify') {
      const reverified = yield* Effect.forEach(eshopMarketSeed, (company) => seedCompany(company, 'dry-run'), {
        concurrency: 1,
      });
      const pending = reverified.flatMap(({ pending: items }) => items);
      if (pending.length > 0) {
        return yield* new DemoSeedError({ reason: `E-shop markets seed incomplete: ${pending.join('; ')}` });
      }
    }
    return yield* Console.log(`E-shop markets seed ${mode} finished`);
  });

const command = Command.make(
  'seed-eshop-markets',
  { mode: Flag.Literals('mode', modes).pipe(Flag.withDefault('dry-run')) },
  ({ mode }) =>
    main(mode).pipe(
      Effect.tapError((failure) =>
        Console.error(
          Schema.is(DemoSeedError)(failure)
            ? failure.reason
            : `E-shop markets seed stopped (${Option.getOrElse(Option.fromNullishOr(failure._tag), () => 'failure')}); credentials not logged`,
        ),
      ),
    ),
);

if (import.meta.main) {
  const runtime = Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  );
  const result = await Effect.runPromiseExit(Effect.scoped(Layer.build(runtime)));
  process.exitCode = Exit.isFailure(result) ? 1 : 0;
}
