#!/usr/bin/env node
/**
 * LOCAL ONLY. Prepares the waiting platform approval batch for the in-app demo guide.
 *
 * node scripts/demo/prepare-agent-platform-batch.mts --intent-file /absolute/path/to/proposal-intent.json
 * Reuse that file after an uncertain failure; a new action intent needs a new file. It stores the exact request,
 * never credentials, and is kept as a replay receipt after success. Run from app/ (or ontos-runtime/app).
 */
import { randomUUID } from 'node:crypto';
import { NodeServices } from '@effect/platform-node';
import { Array as EffectArray, Config, Console, Effect, Exit, FileSystem, Order, Redacted, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http';
import type { Headers } from 'effect/http';
import {
  AgentProposalSubmitRequestSchema,
  AgentProposalSubmitResponseSchema,
  AgentQueueResponseSchema,
} from '../../packages/shared-contracts/src/agent-proposals.ts';
import { DemoSeedError } from './seed-client.mts';

const legalEntityId = '71000000-0000-4000-8000-000000000020';
/** The guide finds the batch by this instruction; keep it stable. */
const instruction = 'Promítni nový ceník dodavatele (+5 %) do ceny jednoho produktu a připrav úkol pro obchodníky.';
export const SubmissionIntentSchema = Schema.Struct({
  idempotencyKey: Schema.toEncoded(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).pipe(Schema.brand('AgentProposalIntentKey')),
  ),
  payload: AgentProposalSubmitRequestSchema,
  shellUrl: Schema.String,
});
const CompanyRequest = Schema.Struct({ legalEntityId: AgentProposalSubmitRequestSchema.fields.legalEntityId });
const GatewayRequest = Schema.Struct({
  audience: Schema.String,
  compositionRevision: Schema.String,
  legalEntityId: AgentProposalSubmitRequestSchema.fields.legalEntityId,
});
const Gateway = Schema.Struct({ apiBaseUrl: Schema.String, token: Schema.Redacted(Schema.String) });
const Composition = Schema.Struct({ composition: Schema.Struct({ revision: Schema.String }) });
const RecordsRequest = Schema.Struct({
  view: Schema.Struct({
    active: Schema.Boolean,
    limit: Schema.Int,
    ordersLimit: Schema.Int,
    productSort: Schema.String,
    summary: Schema.Boolean,
  }),
});
const MerchandiseRecords = Schema.Struct({
  products: Schema.Array(
    Schema.Struct({
      active: Schema.Boolean,
      currentPriceMinor: Schema.Number,
      id: Schema.String,
      name: Schema.String,
      sku: Schema.String,
      variantSummary: Schema.optionalKey(Schema.Struct({ count: Schema.Int })),
    }),
  ),
});
const configuration = Config.all({
  apiKey: Config.Redacted('ONTOS_AGENT_API_KEY'),
  compositionUrl: Config.String('ONTOS_COMPOSITION_URL').pipe(Config.withDefault('http://127.0.0.1:3041')),
  shellUrl: Config.String('ONTOS_SHELL_URL').pipe(Config.withDefault('http://localhost:3020')),
});
const czk = (minor: number) =>
  new Intl.NumberFormat('cs-CZ', { currency: 'CZK', style: 'currency' }).format(minor / 100);
const checked = (response: HttpClientResponse.HttpClientResponse) =>
  response.status === 200
    ? Effect.succeed(response)
    : Effect.fail(
        new DemoSeedError({
          reason: `Proposal preparation stopped: HTTP ${response.status}. Keep the intent file and rerun with the same file; no new request was generated.`,
        }),
      );
const post = <P extends Schema.Top>(
  origin: string,
  path: string,
  schema: P,
  payload: P['Type'],
  headers: Headers.Input,
) =>
  Effect.gen(function* postRequest() {
    const http = yield* HttpClient.HttpClient;
    const request = yield* HttpClientRequest.schemaBodyJson(schema)(
      HttpClientRequest.post(`${origin}${path}`).pipe(
        HttpClientRequest.setHeaders(headers),
        HttpClientRequest.setHeaders({ origin, 'x-correlation-id': randomUUID() }),
      ),
      payload,
    );
    return yield* http.execute(request).pipe(Effect.flatMap(checked));
  });

/** Persisted input is replayed before any reads can rebuild a different price command. */
export const prepareAgentPlatformBatch = (intentFile: string) =>
  Effect.gen(function* prepareBatch() {
    const { apiKey, compositionUrl, shellUrl } = yield* configuration;
    const fs = yield* FileSystem.FileSystem;
    const agentHeaders = { 'x-api-key': Redacted.value(apiKey) };
    const submit = (intent: typeof SubmissionIntentSchema.Type) =>
      Effect.gen(function* submitIntent() {
        if (intent.shellUrl !== shellUrl) {
          return yield* new DemoSeedError({ reason: 'An intent must be retried against its original shell URL.' });
        }
        const result = yield* post(
          shellUrl,
          '/shell-super-app-api/agent-platform/proposals',
          AgentProposalSubmitRequestSchema,
          intent.payload,
          { ...agentHeaders, 'idempotency-key': intent.idempotencyKey },
        ).pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(AgentProposalSubmitResponseSchema)));
        return yield* Console.log(`Dávka ${result.batchId} čeká na schválení na ${shellUrl}${result.reviewPath}.`);
      });
    if (yield* fs.exists(intentFile)) {
      const intent = yield* fs
        .readFileString(intentFile)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(SubmissionIntentSchema))));
      return yield* submit(intent);
    }

    // Reusing a pending batch is only a convenience read, not ingress command idempotency.
    const listed = yield* post(
      shellUrl,
      '/shell-super-app-api/agent-platform/proposals/list',
      CompanyRequest,
      { legalEntityId },
      agentHeaders,
    ).pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(AgentQueueResponseSchema)));
    const existing = listed.batches.find(
      (batch) =>
        batch.instruction === instruction &&
        batch.items.length > 0 &&
        batch.items.every((item) => item.status === 'pending'),
    );
    if (existing !== undefined) {
      return yield* Console.log(`Dávka už čeká na schválení (${existing.batchId}); nic nového nevzniklo.`);
    }
    const http = yield* HttpClient.HttpClient;
    const active = yield* http
      .get(`${compositionUrl}/active`)
      .pipe(Effect.flatMap(checked), Effect.flatMap(HttpClientResponse.schemaBodyJson(Composition)));
    const { revision } = active.composition;
    const gateway = yield* post(
      shellUrl,
      '/shell-super-app-api/auth/api-key/gateway-context',
      GatewayRequest,
      { audience: 'merchandise', compositionRevision: revision, legalEntityId },
      agentHeaders,
    ).pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Gateway)));
    const records = yield* post(
      shellUrl,
      `${gateway.apiBaseUrl}/reads/records`,
      RecordsRequest,
      { view: { active: true, limit: 250, ordersLimit: 0, productSort: 'name', summary: true } },
      { authorization: `Bearer ${Redacted.value(gateway.token)}`, 'x-ontos-composition-revision': revision },
    ).pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(MerchandiseRecords)));
    const [product] = EffectArray.sort(
      records.products.filter(
        (entry) => entry.active && entry.currentPriceMinor >= 10_000 && (entry.variantSummary?.count ?? 0) === 0,
      ),
      Order.make<(typeof records.products)[number]>((left, right) => {
        const compared = left.name.localeCompare(right.name, 'cs');
        if (compared < 0) {
          return -1;
        }
        return compared > 0 ? 1 : 0;
      }),
    );
    if (product === undefined) {
      return yield* new DemoSeedError({ reason: 'Chybí aktivní produkt bez variant s cenou alespoň 100 Kč.' });
    }
    const newPriceMinor = Math.round((product.currentPriceMinor * 1.05) / 100) * 100;
    const taskTitle = `Informovat zákazníky o nové ceně: ${product.name}`.slice(0, 200);
    const intent = yield* Schema.decodeUnknownEffect(SubmissionIntentSchema)({
      idempotencyKey: randomUUID(),
      payload: {
        instruction,
        legalEntityId,
        proposals: [
          {
            appId: 'merchandise',
            command: { _tag: 'ChangePrice', id: product.id, priceMinor: newPriceMinor },
            diff: [
              {
                after: czk(newPriceMinor),
                before: czk(product.currentPriceMinor),
                field: 'currentPriceMinor',
                label: 'Cena bez DPH',
              },
            ],
            reason: 'Podle zadání: cena +5 % podle nového ceníku dodavatele, zaokrouhleno na celé koruny.',
            risk: 'medium',
            summary: 'Změna ceny produktu',
            targetLabel: `${product.name} (${product.sku})`,
          },
          {
            appId: 'work-tasks',
            command: {
              _tag: 'CreateTask',
              description: 'Po schválení nové ceny projít otevřené nabídky a informovat stálé zákazníky.',
              priority: 'NORMAL',
              title: taskTitle,
            },
            diff: [
              { after: taskTitle, field: 'title', label: 'Název úkolu' },
              { after: 'Normální', field: 'priority', label: 'Priorita' },
            ],
            reason: 'Změna ceny se týká otevřených nabídek; obchodníci mají zákazníky upozornit.',
            risk: 'low',
            summary: 'Nový úkol',
            targetLabel: 'Úkoly obchodu',
          },
        ],
        runId: `presenter-platform-${randomUUID()}`,
      },
      shellUrl,
    });
    yield* fs.writeFileString(
      intentFile,
      yield* Schema.encodeEffect(Schema.fromJsonString(SubmissionIntentSchema))(intent),
      { flag: 'wx', mode: 0o600 },
    );
    return yield* submit(intent);
  });

const command = Command.make(
  'prepare-agent-platform-batch',
  { intentFile: Flag.String('intent-file') },
  ({ intentFile }) => prepareAgentPlatformBatch(intentFile),
);
if (import.meta.main) {
  const result = await Effect.runPromiseExit(
    Command.run(command, { version: '1.0.0' }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provide(FetchHttpClient.layer),
      Effect.tapError(() =>
        Console.error(
          'Proposal preparation failed. Keep the intent file and reuse it for retry; credentials and response bodies are not logged.',
        ),
      ),
    ),
  );
  if (Exit.isFailure(result)) {
    process.exitCode = 1;
  }
}
