#!/usr/bin/env node
/** Live local sales-demo proof. Writes a WON opportunity, a price change and a bot task. */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { NodeServices } from '@effect/platform-node';
import { Clock, Config, ConfigProvider, Console, Effect, Exit, FileSystem, Path, Redacted, Schema } from 'effect';
import { Cookies, FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http';

import { demoLegalEntityId } from './fixture-ids.mts';

const WON_INVOICE_TIMEOUT_MS = 30_000;
const BILLING = 'finance-billing';
const WORK = 'work-tasks';
const PIPELINE = 'sales-pipeline';
const ProofLegalEntityId = Schema.toEncoded(Schema.String.pipe(Schema.brand('DemoProofLegalEntityId')));
const ProofProductId = Schema.toEncoded(Schema.String.pipe(Schema.brand('DemoProofProductId')));
const ProofPartyId = Schema.toEncoded(Schema.String.pipe(Schema.brand('DemoProofPartyId')));
const ProofOpportunityId = Schema.toEncoded(Schema.String.pipe(Schema.brand('DemoProofOpportunityId')));
const GATEWAY_PATH = '/shell-super-app-api/auth/gateway-context';
const API_KEY_GATEWAY_PATH = '/shell-super-app-api/auth/api-key/gateway-context';
class DemoProofError extends Schema.TaggedError<DemoProofError>()('DemoProofError', { reason: Schema.String }) {}
const demoConfig = Config.all({
  apiKey: Config.Redacted('ONTOS_AGENT_API_KEY'),
  compositionUrl: Config.String('ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL').pipe(
    Config.withDefault('http://127.0.0.1:3041/active'),
  ),
  credential: Config.Redacted('ONTOS_DEMO_PASSWORD').pipe(Config.withDefault(Redacted.make('password1234'))),
  shellUrl: Config.String('ONTOS_SHELL_URL').pipe(Config.withDefault('http://localhost:3020')),
});
const Composition = Schema.Struct({ composition: Schema.Struct({ revision: Schema.String }) });
const Gateway = Schema.Struct({
  apiBaseUrl: Schema.String,
  compositionRevision: Schema.String,
  token: Schema.Redacted(Schema.String),
});
const SignIn = Schema.Struct({ email: Schema.String, password: Schema.Redacted(Schema.String) });
const GatewayRequest = Schema.Struct({
  audience: Schema.String,
  compositionRevision: Schema.String,
  legalEntityId: ProofLegalEntityId,
});
const Revision = Schema.Struct({ revision: Schema.Number });
const ErrorCode = Schema.Struct({ _tag: Schema.optionalKey(Schema.String), code: Schema.optionalKey(Schema.String) });
const UnchangedResult = Schema.Struct({ changed: Schema.Literal(false) });
const EmptyRead = Schema.Struct({});
const MerchandiseRead = Schema.Struct({
  view: Schema.Struct({ limit: Schema.Number, ordersLimit: Schema.Number, summary: Schema.Boolean }),
});
const InvoiceReference = Schema.Struct({
  moduleId: Schema.Literal('finance.billing'),
  resourceId: Schema.toEncoded(Schema.String.pipe(Schema.brand('DemoProofResourceId'))),
  resourceType: Schema.Literal('finance.billing.invoice'),
  tenantId: Schema.toEncoded(Schema.String.pipe(Schema.brand('DemoProofTenantId'))),
});
interface HttpOutcome {
  readonly body: Schema.Json;
  readonly status: number;
}
const outcome = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function* readOutcome() {
    const text = yield* response.text;
    const body = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(text).pipe(
      Effect.orElseSucceed(() => text),
    );
    return { body, status: response.status } satisfies HttpOutcome;
  });
const post = <S extends Schema.Top>(
  url: string,
  schema: S,
  body: S['Type'],
  headers: Readonly<Record<string, string>>,
) =>
  Effect.gen(function* postRequest() {
    const client = yield* HttpClient.HttpClient;
    const request = yield* HttpClientRequest.schemaBodyJson(schema)(
      HttpClientRequest.post(url).pipe(HttpClientRequest.setHeaders({ 'x-correlation-id': randomUUID(), ...headers })),
      body,
    );
    return yield* client.execute(request).pipe(Effect.timeout('20 seconds'));
  });
const currentRevision = (url: string) =>
  Effect.gen(function* readRevision() {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(url).pipe(Effect.timeout('10 seconds'));
    const { composition } = yield* HttpClientResponse.schemaBodyJson(Composition)(response);
    return composition.revision;
  });
const LineSchema = Schema.Struct({
  productId: Schema.optionalKey(ProofProductId),
  productName: Schema.String,
  quantity: Schema.Number,
  unitPriceMinor: Schema.Number,
  vatRate: Schema.Number,
});
type Line = typeof LineSchema.Type;
const Opportunity = Schema.Struct({
  id: Schema.String,
  lines: Schema.Array(LineSchema),
  partyId: ProofPartyId,
  stage: Schema.String,
  title: Schema.String,
});
const PipelineRecords = Schema.Struct({ items: Schema.Array(Opportunity) });
const InvoiceLineSchema = Schema.Struct({
  description: Schema.String,
  productId: Schema.optionalKey(ProofProductId),
  quantity: Schema.Number,
  unitPriceMinor: Schema.Number,
  vatRate: Schema.Number,
});
type InvoiceLine = typeof InvoiceLineSchema.Type;
const ProofCommandSchema = Schema.Union([
  Schema.TaggedStruct('ChangeOpportunityStage', {
    id: ProofOpportunityId,
    note: Schema.String,
    toStage: Schema.Literal('WON'),
  }),
  Schema.TaggedStruct('CreateInvoiceFromOpportunity', {
    lines: Schema.Array(InvoiceLineSchema),
    opportunityId: ProofOpportunityId,
    partyId: ProofPartyId,
  }),
  Schema.TaggedStruct('ChangePrice', { id: ProofProductId, priceMinor: Schema.Number }),
  Schema.TaggedStruct('ConfirmInvoice', { invoiceRef: InvoiceReference }),
  Schema.TaggedStruct('CreateTask', {
    description: Schema.String,
    partyId: ProofPartyId,
    priority: Schema.Literal('NORMAL'),
    title: Schema.String,
  }),
  Schema.TaggedStruct('DeleteTag', { id: Schema.toEncoded(Schema.String.pipe(Schema.brand('DemoProofTagId'))) }),
]);
type ProofCommand = typeof ProofCommandSchema.Type;
const ApplyCommand = Schema.Struct({ command: ProofCommandSchema, expectedRevision: Schema.Number });
const InvoiceSchema = Schema.Struct({
  businessState: Schema.String,
  lines: Schema.optionalKey(Schema.Array(InvoiceLineSchema)),
  number: Schema.optionalKey(Schema.String),
  opportunityId: Schema.optionalKey(ProofOpportunityId),
  partyId: Schema.optionalKey(ProofPartyId),
  ref: InvoiceReference,
  subtotalMinor: Schema.optionalKey(Schema.Number),
  totalMinor: Schema.Number,
  vatMinor: Schema.optionalKey(Schema.Number),
  vatRecap: Schema.optionalKey(
    Schema.Array(Schema.Struct({ baseMinor: Schema.Number, rate: Schema.Number, vatMinor: Schema.Number })),
  ),
});
type Invoice = typeof InvoiceSchema.Type;
const BillingRecords = Schema.Struct({
  indicators: Schema.Record(Schema.String, Schema.Number),
  revision: Schema.Number,
  state: Schema.Struct({ invoices: Schema.Array(InvoiceSchema) }),
});
const Product = Schema.Struct({
  currentPriceMinor: Schema.Number,
  id: Schema.String,
  name: Schema.String,
  priceHistory: Schema.Array(Schema.Struct({ effectiveFrom: Schema.String, priceMinor: Schema.Number })),
});
const Order = Schema.Struct({
  id: Schema.String,
  lines: Schema.Array(Schema.Struct({ ...LineSchema.fields, productId: ProofProductId })),
  number: Schema.String,
  totalMinor: Schema.Number,
  totalVatMinor: Schema.Number,
});
const MerchandiseRecords = Schema.Struct({ orders: Schema.Array(Order), products: Schema.Array(Product) });
export const makePrincipalClient = (shellUrl: string, credential: Redacted.Redacted) => {
  const principal = (
    label: string,
    credentials: Readonly<Record<string, string>>,
    issuePath: string,
    revision: string,
  ) => {
    const call = <S extends Schema.Top>(
      audience: string,
      path: string,
      schema: S,
      body: S['Type'],
      headers: Readonly<Record<string, string>> = {},
    ) =>
      Effect.gen(function* callOwner() {
        const response = yield* post(
          `${shellUrl}${issuePath}`,
          GatewayRequest,
          { audience, compositionRevision: revision, legalEntityId: demoLegalEntityId },
          credentials,
        );
        if (response.status !== 200) {
          return yield* outcome(response);
        }
        const gateway = yield* HttpClientResponse.schemaBodyJson(Gateway)(response);
        return yield* post(`${shellUrl}${gateway.apiBaseUrl}${path}`, schema, body, {
          authorization: `Bearer ${Redacted.value(gateway.token)}`,
          'x-ontos-composition-revision': gateway.compositionRevision,
          ...headers,
        }).pipe(Effect.flatMap(outcome));
      });
    // Merchandise reads are bounded: list rows (summary) for the whole sales-demo catalog and its orders.
    const read = (audience: string) =>
      audience === 'merchandise'
        ? call(audience, '/reads/records', MerchandiseRead, { view: { limit: 250, ordersLimit: 250, summary: true } })
        : call(audience, '/reads/records', EmptyRead, {});
    const records = <S extends Schema.Top>(audience: string, schema: S) =>
      Effect.gen(function* readRecords() {
        const result = yield* read(audience);
        if (result.status !== 200) {
          return yield* new DemoProofError({ reason: `${label} read ${audience}: HTTP ${result.status}` });
        }
        return yield* Schema.decodeUnknownEffect(schema)(result.body);
      });
    const sendCommand = (audience: string, command: ProofCommand) =>
      Effect.gen(function* sendCommandProgram() {
        const current = yield* read(audience);
        const expectedRevision =
          current.status === 200 ? (yield* Schema.decodeUnknownEffect(Revision)(current.body)).revision : 0;
        return yield* call(
          audience,
          `/${audience}/actions/apply-command`,
          ApplyCommand,
          { command, expectedRevision },
          { 'idempotency-key': randomUUID() },
        );
      });
    const apply = (audience: string, command: ProofCommand) =>
      Effect.gen(function* applyCommand() {
        const send = sendCommand(audience, command);
        const first = yield* send;
        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(first.body);
        return first.status === 409 && encoded.includes('revision') ? yield* send : first;
      });
    return { apply, read, records };
  };
  return {
    bot: (apiKey: Redacted.Redacted, revision: string) =>
      principal('agent-bot', { 'x-api-key': Redacted.value(apiKey) }, API_KEY_GATEWAY_PATH, revision),
    signIn: (email: string, revision: string) =>
      Effect.gen(function* signIn() {
        const response = yield* post(
          `${shellUrl}/shell-super-app-api/auth/sign-in`,
          SignIn,
          { email, password: credential },
          { origin: shellUrl },
        );
        if (response.status !== 200) {
          return yield* new DemoProofError({ reason: `Sign-in ${email}: HTTP ${response.status}` });
        }
        return principal(
          email,
          { cookie: Cookies.toCookieHeader(response.cookies), origin: shellUrl },
          GATEWAY_PATH,
          revision,
        );
      }),
  };
};
const results: { readonly detail: string; readonly name: string; readonly pass: boolean }[] = [];
const check = (name: string, pass: boolean, detail = '') => {
  results.push({ detail, name, pass });
  const suffix = detail === '' ? '' : `  — ${detail}`;
  return Console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${suffix}`);
};
const brief = (response: HttpOutcome): string => {
  const code = Schema.is(ErrorCode)(response.body) ? (response.body.code ?? response.body._tag ?? '') : '';
  const suffix = code === '' ? '' : ` ${code}`;
  return `HTTP ${response.status}${suffix}`;
};
const czk = (minor: number) => `${(minor / 100).toLocaleString('cs-CZ')} Kč`;
export const expectedTotals = (lines: readonly Line[]) => {
  const subtotalMinor = lines.reduce((sum, line) => sum + line.quantity * line.unitPriceMinor, 0);
  const vatMinor = lines.reduce(
    (sum, line) => sum + Math.floor((line.quantity * line.unitPriceMinor * line.vatRate + 50) / 100),
    0,
  );
  return { subtotalMinor, totalMinor: subtotalMinor + vatMinor, vatMinor };
};
export const asInvoiceLines = (lines: readonly Line[]): readonly InvoiceLine[] =>
  lines.map((line) => {
    const { productName, ...snapshot } = line;
    return { ...snapshot, description: productName };
  });
type ProofPrincipal = ReturnType<ReturnType<typeof makePrincipalClient>['bot']>;
const proveInvoice = (headOfSales: ProofPrincipal) =>
  Effect.gen(function* proveInvoiceProgram() {
    yield* Console.log('— Requirement 5: opportunity WON → exactly one draft invoice');
    const pipeline = yield* headOfSales.records(PIPELINE, PipelineRecords);
    const billingBefore = yield* headOfSales.records(BILLING, BillingRecords);
    const merchandiseBefore = yield* headOfSales.records('merchandise', MerchandiseRecords);
    const invoicedOpportunities = new Set(billingBefore.state.invoices.map((invoice) => invoice.opportunityId));
    const orderedProducts = new Set(
      merchandiseBefore.orders.flatMap((order) => order.lines.map((line) => line.productId)),
    );
    const candidates = pipeline.items.filter(
      (item) =>
        item.stage !== 'WON' && item.stage !== 'LOST' && item.lines.length > 0 && !invoicedOpportunities.has(item.id),
    );
    // Prefer an opportunity whose product also appears on an existing order, so proof 2 can check both snapshots.
    const opportunity =
      candidates.find((item) =>
        item.lines.some((line) => line.productId !== undefined && orderedProducts.has(line.productId)),
      ) ?? candidates[0];
    if (opportunity === undefined) {
      yield* check('open opportunity with product lines exists', false, 'none left; reset the demo data');
      return yield* new DemoProofError({ reason: 'No open opportunity with product lines; reset demo data' });
    }
    yield* Console.log(
      `opportunity "${opportunity.title}" (${opportunity.id}), stage ${opportunity.stage}, ${opportunity.lines.length} line(s)`,
    );

    const won = yield* headOfSales.apply(PIPELINE, {
      _tag: 'ChangeOpportunityStage',
      id: opportunity.id,
      note: 'prove-sales-demo: WON',
      toStage: 'WON',
    });
    yield* check('obchod@ ChangeOpportunityStage → WON', won.status === 200, brief(won));

    const wonAt = yield* Clock.currentTimeMillis;
    let drafted: readonly Invoice[] = [];
    while ((yield* Clock.currentTimeMillis) - wonAt < WON_INVOICE_TIMEOUT_MS) {
      const billing = yield* headOfSales.records(BILLING, BillingRecords);
      drafted = billing.state.invoices.filter((invoice) => invoice.opportunityId === opportunity.id);
      if (drafted.length > 0) {
        break;
      }
      yield* Effect.sleep('1 second');
    }
    const elapsed = (((yield* Clock.currentTimeMillis) - wonAt) / 1000).toFixed(1);
    const [invoice] = drafted;
    yield* check(
      'exactly one invoice for the opportunity within 30 s',
      drafted.length === 1,
      `${drafted.length} invoice(s) after ${elapsed} s: ${invoice?.number ?? 'unavailable'}`,
    );
    if (invoice !== undefined) {
      const expected = expectedTotals(opportunity.lines);
      yield* check('invoice is DRAFT', invoice.businessState === 'DRAFT', invoice.businessState);
      yield* check('invoice partyId = opportunity partyId', invoice.partyId === opportunity.partyId);
      yield* check(
        'invoice lines = opportunity line snapshots',
        isDeepStrictEqual(invoice.lines, asInvoiceLines(opportunity.lines)),
        `${invoice.lines?.length ?? 0} line(s)`,
      );
      yield* check(
        'invoice totals correct (subtotal, VAT per line half-up, total)',
        invoice.subtotalMinor === expected.subtotalMinor &&
          invoice.vatMinor === expected.vatMinor &&
          invoice.totalMinor === expected.totalMinor,
        `${czk(invoice.totalMinor)} = ${czk(expected.subtotalMinor)} + DPH ${czk(expected.vatMinor)}`,
      );
      const replay = yield* headOfSales.apply(BILLING, {
        _tag: 'CreateInvoiceFromOpportunity',
        lines: asInvoiceLines(opportunity.lines),
        opportunityId: opportunity.id,
        partyId: opportunity.partyId,
      });
      const afterReplay = yield* headOfSales.records(BILLING, BillingRecords);
      const count = afterReplay.state.invoices.filter((item) => item.opportunityId === opportunity.id).length;
      yield* check(
        'replayed CreateInvoiceFromOpportunity is idempotent (still one invoice, changed=false)',
        replay.status === 200 && Schema.is(UnchangedResult)(replay.body) && count === 1,
        `${brief(replay)}, ${count} invoice(s)`,
      );
    }

    return { invoice, merchandiseBefore, opportunity, orderedProducts };
  });
type InvoiceProof = Effect.Success<ReturnType<typeof proveInvoice>>;
const verifySnapshots = (
  opportunityId: string,
  invoiceSnapshot: Invoice | undefined,
  billingSnapshot: typeof BillingRecords.Type,
  billingAfter: typeof BillingRecords.Type,
  orderBefore: (typeof MerchandiseRecords.Type)['orders'][number] | undefined,
  merchandiseAfter: typeof MerchandiseRecords.Type,
) =>
  Effect.gen(function* verifySnapshotsProgram() {
    const invoiceAfter = billingAfter.state.invoices.find((item) => item.opportunityId === opportunityId);
    yield* check(
      'invoice lines and totals unchanged',
      invoiceAfter !== undefined &&
        isDeepStrictEqual(invoiceAfter.lines, invoiceSnapshot?.lines) &&
        invoiceAfter.totalMinor === invoiceSnapshot?.totalMinor &&
        isDeepStrictEqual(invoiceAfter.vatRecap, invoiceSnapshot?.vatRecap),
      czk(invoiceAfter?.totalMinor ?? 0),
    );
    yield* check(
      'billing revenue indicator unchanged',
      billingAfter.indicators.revenueMinor === billingSnapshot.indicators.revenueMinor,
      czk(billingAfter.indicators.revenueMinor ?? 0),
    );
    if (orderBefore !== undefined) {
      const orderAfter = merchandiseAfter.orders.find((order) => order.id === orderBefore.id);
      yield* check(
        `order ${orderBefore.number} lines and totals unchanged`,
        orderAfter !== undefined &&
          isDeepStrictEqual(orderAfter.lines, orderBefore.lines) &&
          orderAfter.totalMinor === orderBefore.totalMinor &&
          orderAfter.totalVatMinor === orderBefore.totalVatMinor,
        czk(orderAfter?.totalMinor ?? 0),
      );
    }
  });
const provePrice = (
  headOfSales: ProofPrincipal,
  { invoice, merchandiseBefore, opportunity, orderedProducts }: InvoiceProof,
) =>
  Effect.gen(function* provePriceProgram() {
    yield* Console.log('\n— Requirement 7d: price change keeps invoices and orders unchanged');
    const priced =
      opportunity.lines.find((line) => line.productId !== undefined && orderedProducts.has(line.productId)) ??
      opportunity.lines.find((line) => line.productId !== undefined);
    const productBefore = merchandiseBefore.products.find((product) => product.id === priced?.productId);
    const orderBefore = merchandiseBefore.orders.find((order) =>
      order.lines.some((line) => line.productId === priced?.productId),
    );
    if (productBefore === undefined || invoice === undefined) {
      yield* check('product on the new invoice found in merchandise', false);
    } else {
      yield* check(
        'existing order uses the same product',
        orderBefore !== undefined,
        orderBefore?.number ?? 'no order',
      );
      const newPrice = Math.round(productBefore.currentPriceMinor * 1.1);
      const billingSnapshot = yield* headOfSales.records(BILLING, BillingRecords);
      const invoiceSnapshot = billingSnapshot.state.invoices.find((item) => item.opportunityId === opportunity.id);
      const changed = yield* headOfSales.apply('merchandise', {
        _tag: 'ChangePrice',
        id: productBefore.id,
        priceMinor: newPrice,
      });
      yield* check(
        `obchod@ ChangePrice "${productBefore.name}" +10 %`,
        changed.status === 200,
        `${czk(productBefore.currentPriceMinor)} → ${czk(newPrice)}, ${brief(changed)}`,
      );
      const merchandiseAfter = yield* headOfSales.records('merchandise', MerchandiseRecords);
      const billingAfter = yield* headOfSales.records(BILLING, BillingRecords);
      const productAfter = merchandiseAfter.products.find((product) => product.id === productBefore.id);
      yield* check(
        'product currentPrice changed',
        productAfter?.currentPriceMinor === newPrice,
        czk(productAfter?.currentPriceMinor ?? 0),
      );
      yield* check(
        'priceHistory has a new entry with the new price',
        productAfter?.priceHistory.length === productBefore.priceHistory.length + 1 &&
          productAfter.priceHistory.at(-1)?.priceMinor === newPrice,
        `${productBefore.priceHistory.length} → ${productAfter?.priceHistory.length ?? 0} entries`,
      );
      yield* verifySnapshots(
        opportunity.id,
        invoiceSnapshot,
        billingSnapshot,
        billingAfter,
        orderBefore,
        merchandiseAfter,
      );
    }

    return productBefore;
  });
const provePermissions = (
  salesRep: ProofPrincipal,
  warehouse: ProofPrincipal,
  bot: ProofPrincipal,
  { invoice, opportunity }: InvoiceProof,
  productBefore: Effect.Success<ReturnType<typeof provePrice>>,
) =>
  Effect.gen(function* provePermissionsProgram() {
    yield* Console.log('\n— Requirement 10: permissions for employees and the bot');
    if (invoice !== undefined) {
      const confirm = yield* salesRep.apply(BILLING, { _tag: 'ConfirmInvoice', invoiceRef: invoice.ref });
      yield* check('obchodnik@ ConfirmInvoice → 403', confirm.status === 403, brief(confirm));
    }
    const warehousePipeline = yield* warehouse.read(PIPELINE);
    yield* check('sklad@ read pipeline → 403', warehousePipeline.status === 403, brief(warehousePipeline));
    const repPipeline = yield* salesRep.read(PIPELINE);
    yield* check('obchodnik@ read pipeline → 200 (control)', repPipeline.status === 200, brief(repPipeline));

    const botPipeline = yield* bot.read(PIPELINE);
    yield* check('bot read opportunities → 200', botPipeline.status === 200, brief(botPipeline));
    // Metrics (Statistiky, MCP get_metrics) are computed from these owner reads; sales-insights itself stores nothing.
    for (const audience of [BILLING, 'merchandise', WORK]) {
      const metricSource = yield* bot.read(audience);
      yield* check(`bot read ${audience} (metrics source) → 200`, metricSource.status === 200, brief(metricSource));
    }
    const botTask = yield* bot.apply(WORK, {
      _tag: 'CreateTask',
      description: 'Vytvořeno skriptem prove-sales-demo (agent-bot).',
      partyId: opportunity.partyId,
      priority: 'NORMAL',
      title: `Agent: navázat na vyhranou příležitost ${opportunity.title}`,
    });
    yield* check('bot CreateTask → 200', botTask.status === 200, brief(botTask));
    if (invoice !== undefined) {
      const botConfirm = yield* bot.apply(BILLING, { _tag: 'ConfirmInvoice', invoiceRef: invoice.ref });
      yield* check('bot billing ConfirmInvoice → 403', botConfirm.status === 403, brief(botConfirm));
    }
    const botDraft = yield* bot.apply(BILLING, {
      _tag: 'CreateInvoiceFromOpportunity',
      lines: asInvoiceLines(opportunity.lines),
      opportunityId: randomUUID(),
      partyId: opportunity.partyId,
    });
    yield* check('bot billing CreateInvoiceFromOpportunity → 403', botDraft.status === 403, brief(botDraft));
    // A random tag id: the guard must refuse before any state is loaded, and a broken guard cannot delete real data.
    const botDeleteTag = yield* bot.apply('tagging', { _tag: 'DeleteTag', id: randomUUID() });
    yield* check('bot tagging DeleteTag → 403', botDeleteTag.status === 403, brief(botDeleteTag));
    if (productBefore !== undefined) {
      const botPrice = yield* bot.apply('merchandise', {
        _tag: 'ChangePrice',
        id: productBefore.id,
        priceMinor: productBefore.currentPriceMinor,
      });
      yield* check('bot merchandise ChangePrice → 403', botPrice.status === 403, brief(botPrice));
    }
  });
const main = Effect.gen(function* proveSalesDemo() {
  const { apiKey, compositionUrl, credential, shellUrl } = yield* demoConfig;
  const client = makePrincipalClient(shellUrl, credential);
  const revision = yield* currentRevision(compositionUrl);
  const headOfSales = yield* client.signIn('obchod@demo.ontos', revision);
  const salesRep = yield* client.signIn('obchodnik@demo.ontos', revision);
  const warehouse = yield* client.signIn('sklad@demo.ontos', revision);
  const bot = client.bot(apiKey, revision);
  yield* Console.log(`composition ${revision.slice(0, 12)}…, shell ${shellUrl}\n`);

  const invoiceProof = yield* proveInvoice(headOfSales);
  const productBefore = yield* provePrice(headOfSales, invoiceProof);
  yield* provePermissions(salesRep, warehouse, bot, invoiceProof, productBefore);
  const failed = results.filter((result) => !result.pass);
  yield* Console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    yield* new DemoProofError({ reason: `${failed.length} proof checks failed` });
  }
});
const environmentLive = ConfigProvider.layer(
  Effect.gen(function* loadProofConfiguration() {
    const path = yield* Path.Path;
    const envFile = yield* path.fromFileUrl(new URL('../../.env.demo.local', import.meta.url));
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(envFile))) {
      return ConfigProvider.fromEnv();
    }
    const file = yield* ConfigProvider.fromDotEnv({ path: envFile });
    return ConfigProvider.orElse(ConfigProvider.fromEnv(), file);
  }),
);
const runtime = main.pipe(
  Effect.provide(FetchHttpClient.layer),
  Effect.provide(environmentLive),
  Effect.provide(NodeServices.layer),
  Effect.tapError((failure) =>
    Console.error(Schema.is(DemoProofError)(failure) ? failure.reason : `Sales demo proof failed (${failure._tag})`),
  ),
);
if (import.meta.main) {
  const exit = await Effect.runPromiseExit(runtime);
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
