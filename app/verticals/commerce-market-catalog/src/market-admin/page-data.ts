// Page data of the staff E-shop screens (definePageData: prepared before the Shell reveals a page, kept per document,
// revalidated after writes and live changes) and the one way they run Market Actions and merchandise commands.
import { executeManageMarkets } from '@app/merchandise/clients/manage-markets';
import { executeRecords } from '@app/merchandise/clients/records';
import { ManageMarketsPayloadSchema } from '@app/merchandise/contracts/manage-markets';
import type { RecordsRequestEncoded } from '@app/merchandise/contracts/records';
import { executeStorefrontApplications } from '@app/storefront-registry/api/storefront-applications-client';
import { definePageData } from '@app/shared-contracts/page-data';
import { DateTime, Effect, Match, Schema } from 'effect';
import { executeCurrentMarketCatalog } from '../api/current-market-catalog-client.ts';
import { executeMarketAdministration } from '../api/market-administration-client.ts';
import { executeMarketHistory } from '../api/market-history-client.ts';
import { MarketRefSchema } from '../../shared/resources/market.ts';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import { newUuid } from './browser-crypto.ts';

/** This vertical's deployment app id: the stores below reload on its live changes and on those of the apps they read. */
const ownApp = 'commerce-market-catalog';

/** A fresh correlation for one request; Actions use the same value as their idempotency key. */
export const requestId = newUuid.pipe(Effect.map((id) => `commerce-market-catalog:${id}`));

/** Every company's data is its own entry: the key starts with the signed-in legal entity. */
export interface MarketInput {
  readonly legalEntityId: string;
  readonly marketId: string;
  readonly tenantId: string;
}

export const marketRefOf = (input: Pick<MarketInput, 'marketId' | 'tenantId'>) =>
  Schema.decodeUnknownOption(MarketRefSchema)({
    moduleId: 'commerce.market-catalog',
    resourceId: input.marketId,
    resourceType: 'commerce.market-catalog.market',
    tenantId: input.tenantId,
  });

const marketRefEffect = (input: MarketInput) =>
  Schema.decodeUnknownEffect(MarketRefSchema)({
    moduleId: 'commerce.market-catalog',
    resourceId: input.marketId,
    resourceType: 'commerce.market-catalog.market',
    tenantId: input.tenantId,
  });

/** The company's markets and e-shop associations in force now. */
export const marketCatalogData = definePageData({
  changesFrom: [ownApp],
  key: (legalEntityId: string) => legalEntityId,
  load: (_legalEntityId: string) =>
    Effect.all({ at: DateTime.now, id: requestId }, { concurrency: 1 }).pipe(
      Effect.flatMap(({ at, id }) => executeCurrentMarketCatalog({ at }, id)),
    ),
  runtime: browserRuntime,
});

/** The tenant's registered e-shops (storefront registry). */
export const storefrontsData = definePageData({
  changesFrom: [ownApp, 'storefront-registry'],
  key: (legalEntityId: string) => legalEntityId,
  load: (_legalEntityId: string) =>
    Effect.all({ at: DateTime.now, id: requestId }, { concurrency: 1 }).pipe(
      Effect.flatMap(({ at, id }) => executeStorefrontApplications({ at: DateTime.formatIso(at) }, id)),
    ),
  runtime: browserRuntime,
});

const marketSettingsView: RecordsRequestEncoded = { view: { limit: 0, markets: true, ordersLimit: 0, summary: true } };

/** Merchandise market settings (currency, rate, rounding, offer mode) and whether the person manages the catalogue. */
export const marketSettingsData = definePageData({
  changesFrom: [ownApp, 'merchandise'],
  key: (legalEntityId: string) => legalEntityId,
  load: (_legalEntityId: string) => requestId.pipe(Effect.flatMap((id) => executeRecords(marketSettingsView, id))),
  runtime: browserRuntime,
});

/** Whether the person may create markets for the company (no market) or administer one market. */
export const administrationData = definePageData({
  changesFrom: [ownApp],
  key: (input: MarketInput) => `${input.legalEntityId}|${input.marketId}`,
  load: (input: MarketInput) =>
    Effect.all({ id: requestId, marketRef: marketRefEffect(input) }, { concurrency: 1 }).pipe(
      Effect.flatMap(({ id, marketRef }) => executeMarketAdministration({ marketRef }, id)),
    ),
  runtime: browserRuntime,
});

export const creationGrantData = definePageData({
  changesFrom: [ownApp],
  key: (legalEntityId: string) => legalEntityId,
  load: (_legalEntityId: string) => requestId.pipe(Effect.flatMap((id) => executeMarketAdministration({}, id))),
  runtime: browserRuntime,
});

/** Every definition revision of one market. */
export const marketHistoryData = definePageData({
  changesFrom: [ownApp],
  key: (input: MarketInput) => `${input.legalEntityId}|${input.marketId}`,
  load: (input: MarketInput) =>
    Effect.all({ id: requestId, marketRef: marketRefEffect(input) }, { concurrency: 1 }).pipe(
      Effect.flatMap(({ id, marketRef }) => executeMarketHistory({ marketRef }, id)),
    ),
  runtime: browserRuntime,
});

export interface ExceptionsInput extends MarketInput {
  readonly offset: number;
}

export const EXCEPTIONS_PAGE_SIZE = 25;

/** One page of the market's product exceptions (products whose offer differs from the market's offer mode). */
export const marketExceptionsData = definePageData({
  changesFrom: [ownApp, 'merchandise'],
  key: (input: ExceptionsInput) => `${input.legalEntityId}|${input.marketId}|${String(input.offset)}`,
  load: (input: ExceptionsInput) =>
    requestId.pipe(
      Effect.flatMap((id) =>
        executeRecords(
          {
            view: {
              limit: 0,
              marketExceptions: { limit: EXCEPTIONS_PAGE_SIZE, marketId: input.marketId, offset: input.offset },
              ordersLimit: 0,
              summary: true,
            },
          },
          id,
        ),
      ),
    ),
  runtime: browserRuntime,
});

/** Products matching a search text, to add or withdraw them as market exceptions. */
export const searchProducts = (search: string) =>
  requestId.pipe(
    Effect.flatMap((id) => executeRecords({ view: { limit: 10, ordersLimit: 0, search, summary: true } }, id)),
    Effect.map((response) => ({ products: response.products, revision: response.revision })),
  );

/** UI outcome of a write: what to tell the person. Never a raw problem or code. */
export const WriteFailureSchema = Schema.Literals([
  'conflict',
  'forbidden',
  'invalid',
  'rejected',
  'settlementPending',
  'unavailable',
]);
export type WriteFailure = typeof WriteFailureSchema.Type;

interface ProblemLike {
  readonly _tag: string;
}

/** Maps any generated Action/command problem onto the few outcomes the screens distinguish. */
export const writeFailure = (error: ProblemLike): WriteFailure =>
  Match.value(error._tag).pipe(
    // The retirement committed; only its Customer Context settlement is still finishing. Replaying it with a fresh
    // key would be wrong, so the screen reports the committed state instead of a generic failure.
    Match.when(
      (tag) => tag.endsWith('SettlementPendingProblem'),
      (): WriteFailure => 'settlementPending',
    ),
    Match.when(
      (tag) => tag.endsWith('ConflictProblem') || tag.endsWith('AlreadyCommittedProblem'),
      (): WriteFailure => 'conflict',
    ),
    Match.when(
      (tag) => tag.endsWith('ForbiddenProblem') || tag.endsWith('AuthenticationProblem'),
      (): WriteFailure => 'forbidden',
    ),
    Match.when(
      (tag) => tag.endsWith('InvalidProblem') || tag === 'SchemaError',
      (): WriteFailure => 'invalid',
    ),
    Match.when(
      (tag) => tag.endsWith('IneligibleProblem'),
      (): WriteFailure => 'rejected',
    ),
    Match.orElse((): WriteFailure => 'unavailable'),
  );

/** `ok` records transport success, not commitment; a successful value can still be a parked proposal. */
export type WriteOutcome<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly reason: WriteFailure };

/**
 * Runs one Market Action: decodes the form's payload with the Action's own schema (an invalid form never reaches the
 * owner), sends it with a fresh idempotency key and reports the outcome to the screen.
 */
export const runMarketAction = <P, A, E extends ProblemLike, D extends ProblemLike>(
  payload: Effect.Effect<P, D>,
  execute: (
    payload: P,
    requestCorrelation: string,
    options: { readonly idempotencyKey: string },
  ) => Effect.Effect<A, E>,
  onOutcome: (outcome: WriteOutcome<A>) => void,
): void => {
  void browserRuntime.runPromise(
    Effect.all({ decoded: payload, id: requestId }, { concurrency: 1 }).pipe(
      Effect.flatMap(({ decoded, id }) => execute(decoded, id, { idempotencyKey: id })),
      Effect.match({
        onFailure: (error): WriteOutcome<A> => ({ ok: false, reason: writeFailure(error) }),
        onSuccess: (value): WriteOutcome<A> => ({ ok: true, value }),
      }),
      Effect.map(onOutcome),
    ),
  );
};

/**
 * The Effect form of `runMarketAction` for a draft save: never fails, answers with the outcome the screen shows. The
 * payload is decoded with the Action's own schema first, so an invalid form never reaches the owner.
 */
export const marketActionEffect = <P, A, E extends ProblemLike, D extends ProblemLike>(
  payload: Effect.Effect<P, D>,
  execute: (
    payload: P,
    requestCorrelation: string,
    options: { readonly idempotencyKey: string },
  ) => Effect.Effect<A, E>,
): Effect.Effect<WriteOutcome<A>> =>
  Effect.all({ decoded: payload, id: requestId }, { concurrency: 1 }).pipe(
    Effect.flatMap(({ decoded, id }) => execute(decoded, id, { idempotencyKey: id })),
    Effect.match({
      onFailure: (error): WriteOutcome<A> => ({ ok: false, reason: writeFailure(error) }),
      onSuccess: (value): WriteOutcome<A> => ({ ok: true, value }),
    }),
  );

/** A merchandise command in its wire form (the screens build ConfigureMarket and SetProductMarketOffer). */
export type MarketCommandInput = (typeof ManageMarketsPayloadSchema.Encoded)['command'];

/** A committed owner result or its parked 202 proposal receipt. Callers must distinguish them before reporting a write. */
export type MarketCommandResult = Effect.Success<ReturnType<typeof executeManageMarkets>>;

/**
 * One merchandise market command, validated by the owner's payload schema before it is sent. Market commands do not
 * check the catalogue head revision, so the last read revision is sent as is. Fails with the screen outcome.
 */
export const merchandiseCommand = (command: MarketCommandInput, revision: number) =>
  Effect.all(
    {
      id: requestId,
      payload: Schema.decodeUnknownEffect(ManageMarketsPayloadSchema)({ command, expectedRevision: revision }),
    },
    { concurrency: 1 },
  ).pipe(
    Effect.flatMap(({ id, payload }) => executeManageMarkets(payload, id, { idempotencyKey: id })),
    Effect.mapError(writeFailure),
  );

export const runMerchandiseCommand = (
  command: MarketCommandInput,
  revision: number,
  onOutcome: (outcome: WriteOutcome<MarketCommandResult>) => void,
): void => {
  void browserRuntime.runPromise(
    merchandiseCommand(command, revision).pipe(
      Effect.match({
        onFailure: (reason): WriteOutcome<MarketCommandResult> => ({ ok: false, reason }),
        onSuccess: (value): WriteOutcome<MarketCommandResult> => ({ ok: true, value }),
      }),
      Effect.map(onOutcome),
    ),
  );
};

/** A screen reloads at most four reads at once. */
const REFRESH_CONCURRENCY = 4;

/** Reloads the given entries, keeping what is on screen until the fresh data lands. */
export const refreshAll = (...refreshes: readonly Effect.Effect<void>[]): void => {
  browserRuntime.runFork(Effect.all(refreshes, { concurrency: REFRESH_CONCURRENCY, discard: true }));
};
