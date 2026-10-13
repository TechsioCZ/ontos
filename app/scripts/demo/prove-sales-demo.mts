#!/usr/bin/env node
/* oxlint-disable anti-slop/no-conditional-empty-object-spread, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion, effect-native/no-ambient-date, effect-native/no-ambient-process-env, effect-native/no-async-script-program, effect-native/no-direct-node-io-in-scripts, effect-native/no-hand-parsed-environment-value, effect-native/no-native-json-parse, effect-native/no-native-json-stringify, effect-native/no-process-exit-outside-script-entry, effect-native/no-promise-shaped-port, effect-native/no-throw-in-scripts, effect-native/no-unredacted-secret-field, sonarjs/no-duplicate-string, sonarjs/no-nested-template-literals, typescript/no-base-to-string, typescript/no-unsafe-type-assertion, typescript/promise-function-async, typescript/return-await, unicorn/text-encoding-identifier-case -- Plain fetch proof script for the LOCAL sales demo: it drives the live stack over HTTP like a browser, reads untyped JSON on purpose and is not product code. expires: 2027-03-31. */
/**
 * Sales-demo end-to-end proofs against the LIVE local stack (plans 15 won-e2e-proof, 22 permissions-proof).
 * LOCAL ONLY. Writes demo data (one opportunity → WON, one +10 % price change, one bot task).
 *
 *   node scripts/demo/prove-sales-demo.mts
 *
 * 1. Requirement 5: obchod@demo.ontos moves an open opportunity with product lines to WON; within 30 s billing
 *    shows exactly one new DRAFT invoice for it with the same line snapshots and correct totals. A direct
 *    CreateInvoiceFromOpportunity replay (what an outbox redelivery maps to) still leaves exactly one invoice.
 * 2. Requirement 7d: ChangePrice +10 % on a product used by that invoice and by an existing order; invoice and
 *    order lines/totals stay unchanged, currentPrice changes, priceHistory gains one entry.
 * 3. Requirement 10: rep cannot confirm invoices, warehouse cannot read the pipeline, the agent bot (API key
 *    from app/.env.demo.local) reads and creates tasks but is refused billing writes, DeleteTag and ChangePrice.
 *
 * Humans authenticate like the browser: sign-in cookie → POST /shell-super-app-api/auth/gateway-context.
 * The bot uses POST /shell-super-app-api/auth/api-key/gateway-context with x-api-key (same as reset-permissions).
 * Prints PASS/FAIL per check; exit code 1 when any check fails.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';

import { demoLegalEntityId } from './fixture-ids.mts';

// oxlint-disable-next-line sonarjs/no-hardcoded-passwords -- documented local demo credential (README, brief).
const DEMO_PASSWORD = 'password1234';
const ENV_FILE = new URL('../../.env.demo.local', import.meta.url);
const WON_INVOICE_TIMEOUT_MS = 30_000;

const readEnvFile = (): ReadonlyMap<string, string> => {
  if (!existsSync(ENV_FILE)) {
    return new Map();
  }
  return new Map(
    readFileSync(ENV_FILE, 'utf8')
      .split('\n')
      .flatMap((line) => {
        const match = /^(?<key>[A-Z][A-Z0-9_]*)=(?<value>.*)$/u.exec(line.trim());
        return match?.groups?.key === undefined ? [] : [[match.groups.key, match.groups.value ?? ''] as const];
      }),
  );
};
const fileEnv = readEnvFile();
const setting = (key: string, fallback?: string): string => {
  const value = process.env[key] ?? fileEnv.get(key) ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`${key} is not set (environment or app/.env.demo.local)`);
  }
  return value;
};
const shellUrl = setting('ONTOS_SHELL_URL', 'http://localhost:3020').replace(/\/+$/u, '');
const compositionUrl = setting('ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL', 'http://127.0.0.1:3041/active');

// ---------------------------------------------------------------------------------------------------------------
// HTTP client: one principal; a fresh gateway assertion per call.

type Json = Record<string, unknown>;

interface HttpOutcome {
  readonly body: unknown;
  readonly status: number;
}

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

const post = async (url: string, body: unknown, headers: Readonly<Record<string, string>>): Promise<HttpOutcome> => {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-correlation-id': randomUUID(), ...headers },
    method: 'POST',
  });
  return { body: parse(await response.text()), status: response.status };
};

const currentRevision = async (): Promise<string> => {
  const response = await fetch(compositionUrl);
  const body = (await response.json()) as { composition: { revision: string } };
  return body.composition.revision;
};

interface Gateway {
  readonly apiBaseUrl: string;
  readonly compositionRevision: string;
  readonly token: string;
}

class Principal {
  readonly label: string;
  private readonly credentials: Readonly<Record<string, string>>;
  private readonly issuePath: string;
  private readonly revision: string;

  constructor(label: string, credentials: Readonly<Record<string, string>>, issuePath: string, revision: string) {
    this.label = label;
    this.credentials = credentials;
    this.issuePath = issuePath;
    this.revision = revision;
  }

  static async signIn(email: string, revision: string): Promise<Principal> {
    const response = await fetch(`${shellUrl}/shell-super-app-api/auth/sign-in`, {
      body: JSON.stringify({ email, password: DEMO_PASSWORD }),
      headers: { 'content-type': 'application/json', origin: shellUrl, 'x-correlation-id': randomUUID() },
      method: 'POST',
    });
    if (response.status !== 200) {
      throw new Error(`sign-in ${email} failed: HTTP ${response.status}`);
    }
    const cookie = response.headers
      .getSetCookie()
      .map((entry) => entry.split(';')[0])
      .join('; ');
    return new Principal(email, { cookie, origin: shellUrl }, '/shell-super-app-api/auth/gateway-context', revision);
  }

  static bot(apiKey: string, revision: string): Principal {
    return new Principal(
      'agent-bot',
      { 'x-api-key': apiKey },
      '/shell-super-app-api/auth/api-key/gateway-context',
      revision,
    );
  }

  /** Gateway assertions are single-use (replay-protected by jti), so every call issues a fresh one. */
  private async gateway(audience: string): Promise<Gateway | HttpOutcome> {
    const outcome = await post(
      `${shellUrl}${this.issuePath}`,
      { audience, compositionRevision: this.revision, legalEntityId: demoLegalEntityId },
      this.credentials,
    );
    return outcome.status === 200 ? (outcome.body as Gateway) : outcome;
  }

  private async call(
    audience: string,
    path: string,
    body: unknown,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<HttpOutcome> {
    const gateway = await this.gateway(audience);
    if (!('token' in gateway)) {
      return gateway;
    }
    return post(`${shellUrl}${gateway.apiBaseUrl}${path}`, body, {
      authorization: `Bearer ${gateway.token}`,
      'x-ontos-composition-revision': gateway.compositionRevision,
      ...headers,
    });
  }

  read(audience: string, query: Json = {}): Promise<HttpOutcome> {
    return this.call(audience, '/reads/records', query);
  }

  async records<T>(audience: string, query: Json = {}): Promise<T> {
    const outcome = await this.read(audience, query);
    if (outcome.status !== 200) {
      throw new Error(`${this.label} read ${audience}: HTTP ${outcome.status} ${JSON.stringify(outcome.body)}`);
    }
    return outcome.body as T;
  }

  /** apply-command with the current revision (read first, one retry on a revision conflict). */
  async apply(audience: string, command: Json, revisionQuery: Json = {}): Promise<HttpOutcome> {
    const send = async () => {
      const read = await this.read(audience, revisionQuery);
      const revision = read.status === 200 ? (read.body as { revision: number }).revision : 0;
      // Actions require an idempotency key (428 without one); a retry is a new invocation, so a new key.
      return this.call(
        audience,
        `/${audience}/actions/apply-command`,
        { command, expectedRevision: revision },
        { 'idempotency-key': randomUUID() },
      );
    };
    const first = await send();
    return first.status === 409 && JSON.stringify(first.body).includes('revision') ? send() : first;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Wire shapes (subset).

interface Line {
  readonly productId?: string;
  readonly productName: string;
  readonly quantity: number;
  readonly unitPriceMinor: number;
  readonly vatRate: number;
}
interface Opportunity {
  readonly id: string;
  readonly lines: readonly Line[];
  readonly partyId: string;
  readonly stage: string;
  readonly title: string;
}
interface InvoiceLine {
  readonly description: string;
  readonly productId?: string;
  readonly quantity: number;
  readonly unitPriceMinor: number;
  readonly vatRate: number;
}
interface Invoice {
  readonly businessState: string;
  readonly lines?: readonly InvoiceLine[];
  readonly number?: string;
  readonly opportunityId?: string;
  readonly partyId?: string;
  readonly ref: Json;
  readonly subtotalMinor?: number;
  readonly totalMinor: number;
  readonly vatMinor?: number;
  readonly vatRecap?: readonly { readonly baseMinor: number; readonly rate: number; readonly vatMinor: number }[];
}
interface BillingRecords {
  readonly indicators: Readonly<Record<string, number>>;
  readonly revision: number;
  readonly state: { readonly invoices: readonly Invoice[] };
}
interface Product {
  readonly currentPriceMinor: number;
  readonly id: string;
  readonly name: string;
  readonly priceHistory: readonly { readonly effectiveFrom: string; readonly priceMinor: number }[];
}
interface Order {
  readonly id: string;
  readonly lines: readonly (Line & { readonly productId: string })[];
  readonly number: string;
  readonly totalMinor: number;
  readonly totalVatMinor: number;
}
interface MerchandiseRecords {
  readonly orders: readonly Order[];
  readonly products: readonly Product[];
}

// ---------------------------------------------------------------------------------------------------------------
// Reporting.

const results: { readonly detail: string; readonly name: string; readonly pass: boolean }[] = [];
const check = (name: string, pass: boolean, detail = ''): boolean => {
  results.push({ detail, name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`);
  return pass;
};
const brief = (outcome: HttpOutcome): string => {
  const body = outcome.body as Json | null;
  const code = typeof body === 'object' && body !== null ? (body.code ?? body._tag ?? '') : '';
  return `HTTP ${outcome.status}${code === '' ? '' : ` ${String(code)}`}`;
};
const czk = (minor: number) => `${(minor / 100).toLocaleString('cs-CZ')} Kč`;

const expectedTotals = (lines: readonly Line[]) => {
  const subtotalMinor = lines.reduce((sum, line) => sum + line.quantity * line.unitPriceMinor, 0);
  const vatMinor = lines.reduce(
    (sum, line) => sum + Math.floor((line.quantity * line.unitPriceMinor * line.vatRate + 50) / 100),
    0,
  );
  return { subtotalMinor, totalMinor: subtotalMinor + vatMinor, vatMinor };
};
const asInvoiceLines = (lines: readonly Line[]): readonly InvoiceLine[] =>
  lines.map((line) => ({
    description: line.productName,
    ...(line.productId === undefined ? {} : { productId: line.productId }),
    quantity: line.quantity,
    unitPriceMinor: line.unitPriceMinor,
    vatRate: line.vatRate,
  }));

// ---------------------------------------------------------------------------------------------------------------
// Proofs.

const revision = await currentRevision();
const headOfSales = await Principal.signIn('obchod@demo.ontos', revision);
const salesRep = await Principal.signIn('obchodnik@demo.ontos', revision);
const warehouse = await Principal.signIn('sklad@demo.ontos', revision);
const bot = Principal.bot(setting('ONTOS_AGENT_API_KEY'), revision);
console.log(`composition ${revision.slice(0, 12)}…, shell ${shellUrl}\n`);

console.log('— Requirement 5: opportunity WON → exactly one draft invoice');
const pipeline = await headOfSales.records<{ items: readonly Opportunity[] }>('sales-pipeline');
const billingBefore = await headOfSales.records<BillingRecords>('siampark-billing-finance');
const merchandiseBefore = await headOfSales.records<MerchandiseRecords>('merchandise');
const invoicedOpportunities = new Set(billingBefore.state.invoices.map((invoice) => invoice.opportunityId));
const orderedProducts = new Set(merchandiseBefore.orders.flatMap((order) => order.lines.map((line) => line.productId)));
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
  check('open opportunity with product lines exists', false, 'none left; reset the demo data');
  process.exit(1);
}
console.log(
  `opportunity "${opportunity.title}" (${opportunity.id}), stage ${opportunity.stage}, ${opportunity.lines.length} line(s)`,
);

const won = await headOfSales.apply('sales-pipeline', {
  _tag: 'ChangeOpportunityStage',
  id: opportunity.id,
  note: 'prove-sales-demo: WON',
  toStage: 'WON',
});
check('obchod@ ChangeOpportunityStage → WON', won.status === 200, brief(won));

const wonAt = Date.now();
let drafted: readonly Invoice[] = [];
while (Date.now() - wonAt < WON_INVOICE_TIMEOUT_MS) {
  // oxlint-disable-next-line eslint/no-await-in-loop -- sequential 1 s poll for the outbox worker's invoice.
  const billing = await headOfSales.records<BillingRecords>('siampark-billing-finance');
  drafted = billing.state.invoices.filter((invoice) => invoice.opportunityId === opportunity.id);
  if (drafted.length > 0) {
    break;
  }
  // oxlint-disable-next-line eslint/no-await-in-loop -- poll interval of the sequential loop above.
  await sleep(1000);
}
const elapsed = ((Date.now() - wonAt) / 1000).toFixed(1);
const [invoice] = drafted;
check(
  'exactly one invoice for the opportunity within 30 s',
  drafted.length === 1,
  `${drafted.length} invoice(s) after ${elapsed} s${invoice?.number === undefined ? '' : `: ${invoice.number}`}`,
);
if (invoice !== undefined) {
  const expected = expectedTotals(opportunity.lines);
  check('invoice is DRAFT', invoice.businessState === 'DRAFT', invoice.businessState);
  check('invoice partyId = opportunity partyId', invoice.partyId === opportunity.partyId);
  check(
    'invoice lines = opportunity line snapshots',
    isDeepStrictEqual(invoice.lines, asInvoiceLines(opportunity.lines)),
    `${invoice.lines?.length ?? 0} line(s)`,
  );
  check(
    'invoice totals correct (subtotal, VAT per line half-up, total)',
    invoice.subtotalMinor === expected.subtotalMinor &&
      invoice.vatMinor === expected.vatMinor &&
      invoice.totalMinor === expected.totalMinor,
    `${czk(invoice.totalMinor)} = ${czk(expected.subtotalMinor)} + DPH ${czk(expected.vatMinor)}`,
  );
  const replay = await headOfSales.apply('siampark-billing-finance', {
    _tag: 'CreateInvoiceFromOpportunity',
    lines: asInvoiceLines(opportunity.lines),
    opportunityId: opportunity.id,
    partyId: opportunity.partyId,
  });
  const afterReplay = await headOfSales.records<BillingRecords>('siampark-billing-finance');
  const count = afterReplay.state.invoices.filter((item) => item.opportunityId === opportunity.id).length;
  check(
    'replayed CreateInvoiceFromOpportunity is idempotent (still one invoice, changed=false)',
    replay.status === 200 && (replay.body as { changed?: boolean }).changed === false && count === 1,
    `${brief(replay)}, ${count} invoice(s)`,
  );
}

console.log('\n— Requirement 7d: price change keeps invoices and orders unchanged');
const priced =
  opportunity.lines.find((line) => line.productId !== undefined && orderedProducts.has(line.productId)) ??
  opportunity.lines.find((line) => line.productId !== undefined);
const productBefore = merchandiseBefore.products.find((product) => product.id === priced?.productId);
const orderBefore = merchandiseBefore.orders.find((order) =>
  order.lines.some((line) => line.productId === priced?.productId),
);
if (productBefore === undefined || invoice === undefined) {
  check('product on the new invoice found in merchandise', false);
} else {
  check('existing order uses the same product', orderBefore !== undefined, orderBefore?.number ?? 'no order');
  const newPrice = Math.round(productBefore.currentPriceMinor * 1.1);
  const billingSnapshot = await headOfSales.records<BillingRecords>('siampark-billing-finance');
  const invoiceSnapshot = billingSnapshot.state.invoices.find((item) => item.opportunityId === opportunity.id);
  const changed = await headOfSales.apply('merchandise', {
    _tag: 'ChangePrice',
    id: productBefore.id,
    priceMinor: newPrice,
  });
  check(
    `obchod@ ChangePrice "${productBefore.name}" +10 %`,
    changed.status === 200,
    `${czk(productBefore.currentPriceMinor)} → ${czk(newPrice)}, ${brief(changed)}`,
  );
  const merchandiseAfter = await headOfSales.records<MerchandiseRecords>('merchandise');
  const billingAfter = await headOfSales.records<BillingRecords>('siampark-billing-finance');
  const productAfter = merchandiseAfter.products.find((product) => product.id === productBefore.id);
  check(
    'product currentPrice changed',
    productAfter?.currentPriceMinor === newPrice,
    czk(productAfter?.currentPriceMinor ?? 0),
  );
  check(
    'priceHistory has a new entry with the new price',
    productAfter?.priceHistory.length === productBefore.priceHistory.length + 1 &&
      productAfter.priceHistory.at(-1)?.priceMinor === newPrice,
    `${productBefore.priceHistory.length} → ${productAfter?.priceHistory.length ?? 0} entries`,
  );
  const invoiceAfter = billingAfter.state.invoices.find((item) => item.opportunityId === opportunity.id);
  check(
    'invoice lines and totals unchanged',
    invoiceAfter !== undefined &&
      isDeepStrictEqual(invoiceAfter.lines, invoiceSnapshot?.lines) &&
      invoiceAfter.totalMinor === invoiceSnapshot?.totalMinor &&
      isDeepStrictEqual(invoiceAfter.vatRecap, invoiceSnapshot.vatRecap),
    czk(invoiceAfter?.totalMinor ?? 0),
  );
  check(
    'billing revenue indicator unchanged',
    billingAfter.indicators.revenueMinor === billingSnapshot.indicators.revenueMinor,
    czk(billingAfter.indicators.revenueMinor ?? 0),
  );
  if (orderBefore !== undefined) {
    const orderAfter = merchandiseAfter.orders.find((order) => order.id === orderBefore.id);
    check(
      `order ${orderBefore.number} lines and totals unchanged`,
      orderAfter !== undefined &&
        isDeepStrictEqual(orderAfter.lines, orderBefore.lines) &&
        orderAfter.totalMinor === orderBefore.totalMinor &&
        orderAfter.totalVatMinor === orderBefore.totalVatMinor,
      czk(orderAfter?.totalMinor ?? 0),
    );
  }
}

console.log('\n— Requirement 10: permissions for employees and the bot');
if (invoice !== undefined) {
  const confirm = await salesRep.apply('siampark-billing-finance', { _tag: 'ConfirmInvoice', invoiceRef: invoice.ref });
  check('obchodnik@ ConfirmInvoice → 403', confirm.status === 403, brief(confirm));
}
const warehousePipeline = await warehouse.read('sales-pipeline');
check('sklad@ read pipeline → 403', warehousePipeline.status === 403, brief(warehousePipeline));
const repPipeline = await salesRep.read('sales-pipeline');
check('obchodnik@ read pipeline → 200 (control)', repPipeline.status === 200, brief(repPipeline));

const botPipeline = await bot.read('sales-pipeline');
check('bot read opportunities → 200', botPipeline.status === 200, brief(botPipeline));
// Metrics (Statistiky, MCP get_metrics) are computed from these owner reads; sales-insights itself stores nothing.
for (const audience of ['siampark-billing-finance', 'merchandise', 'siampark-work']) {
  // oxlint-disable-next-line eslint/no-await-in-loop -- sequential on purpose: one gateway exchange at a time.
  const metricSource = await bot.read(audience);
  check(`bot read ${audience} (metrics source) → 200`, metricSource.status === 200, brief(metricSource));
}
const botTask = await bot.apply('siampark-work', {
  _tag: 'CreateTask',
  description: 'Vytvořeno skriptem prove-sales-demo (agent-bot).',
  partyId: opportunity.partyId,
  priority: 'NORMAL',
  title: `Agent: navázat na vyhranou příležitost ${opportunity.title}`,
});
check('bot CreateTask → 200', botTask.status === 200, brief(botTask));
if (invoice !== undefined) {
  const botConfirm = await bot.apply('siampark-billing-finance', { _tag: 'ConfirmInvoice', invoiceRef: invoice.ref });
  check('bot billing ConfirmInvoice → 403', botConfirm.status === 403, brief(botConfirm));
}
const botDraft = await bot.apply('siampark-billing-finance', {
  _tag: 'CreateInvoiceFromOpportunity',
  lines: asInvoiceLines(opportunity.lines),
  opportunityId: randomUUID(),
  partyId: opportunity.partyId,
});
check('bot billing CreateInvoiceFromOpportunity → 403', botDraft.status === 403, brief(botDraft));
// A random tag id: the guard must refuse before any state is loaded, and a broken guard cannot delete real data.
const botDeleteTag = await bot.apply('tagging', { _tag: 'DeleteTag', id: randomUUID() });
check('bot tagging DeleteTag → 403', botDeleteTag.status === 403, brief(botDeleteTag));
if (productBefore !== undefined) {
  const botPrice = await bot.apply('merchandise', {
    _tag: 'ChangePrice',
    id: productBefore.id,
    priceMinor: productBefore.currentPriceMinor,
  });
  check('bot merchandise ChangePrice → 403', botPrice.status === 403, brief(botPrice));
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exitCode = failed.length === 0 ? 0 : 1;
