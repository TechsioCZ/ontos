#!/usr/bin/env node
/**
 * LOCAL ONLY. Prepares the waiting platform approval batch the in-app demo guide (Obchodní firma, chapter
 * "AI agent A / B / C", step "Ke schválení: návrhy ze všech modulů") walks through: AI agent level C proposes a
 * price change of one product and a follow-up task. Nothing changes until a person approves it in
 * /cs/sprava/ke-schvaleni. Idempotent: a fully pending batch with the same instruction is reused.
 *
 *   node scripts/demo/prepare-agent-platform-batch.mts        # from app/ (or ontos-runtime/app)
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const appRoot = new URL('../..', import.meta.url);
const env = Object.fromEntries(
  readFileSync(new URL('.env.demo.local', appRoot), 'utf8')
    .split('\n')
    .flatMap((line) => {
      const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line.trim());
      return match ? [[match[1], match[2]]] : [];
    }),
);
const shellUrl = process.env.ONTOS_SHELL_URL ?? 'http://localhost:3020';
const compositionUrl = process.env.ONTOS_COMPOSITION_URL ?? 'http://127.0.0.1:3041';
const legalEntityId = '71000000-0000-4000-8000-000000000020'; // Obchodní firma
/** The guide and the presenter find the batch by this instruction; keep it stable. */
const instruction = 'Promítni nový ceník dodavatele (+5 %) do ceny jednoho produktu a připrav úkol pro obchodníky.';

const key = process.env.ONTOS_AGENT_C_OBCHOD_API_KEY ?? env.ONTOS_AGENT_C_OBCHOD_API_KEY;
assert.ok(key, 'Chybí klíč AI úrovně C pro Obchodní firmu: spusťte nejprve pnpm demo:ai-profiles');
const agentHeaders = { 'x-api-key': key };

interface QueueItem {
  readonly status: string;
}
interface QueueBatch {
  readonly batchId: string;
  readonly instruction: string;
  readonly items: readonly QueueItem[];
}
interface QueueResponse {
  readonly batches: readonly QueueBatch[];
}
interface GatewayResponse {
  readonly apiBaseUrl: string;
  readonly token: string;
}
interface Product {
  readonly active: boolean;
  readonly currentPriceMinor: number;
  readonly id: string;
  readonly name: string;
  readonly sku: string;
  readonly variantSummary?: { readonly count: number };
}
interface MerchandiseRecords {
  readonly products: readonly Product[];
}
interface SubmitResponse {
  readonly batchId: string;
  readonly replayed: boolean;
  readonly reviewPath: string;
}

const revision = ((await (await fetch(`${compositionUrl}/active`)).json()) as { composition: { revision: string } })
  .composition.revision;

const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(`${shellUrl}${path}`, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', origin: shellUrl, 'x-correlation-id': randomUUID(), ...headers },
    method: 'POST',
  });
  const text = await response.text();
  const parsed: unknown = (() => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  })();
  return { body: parsed, status: response.status };
};

// 1. Idempotency: reuse a fully pending batch with the same instruction.
const listed = await post('/shell-super-app-api/agent-platform/proposals/list', { legalEntityId }, agentHeaders);
assert.equal(listed.status, 200, JSON.stringify(listed.body));
const existing = (listed.body as QueueResponse).batches.find(
  (batch) =>
    batch.instruction === instruction && batch.items.length > 0 && batch.items.every((item) => item.status === 'pending'),
);
if (existing) {
  console.log(`Dávka už čeká na schválení (${existing.batchId}); nic nového nevzniklo.`);
  process.exit(0);
}

// 2. Gateway assertion for merchandise as the agent.
const gateway = await post(
  '/shell-super-app-api/auth/api-key/gateway-context',
  { audience: 'merchandise', compositionRevision: revision, legalEntityId },
  agentHeaders,
);
assert.equal(gateway.status, 200, JSON.stringify(gateway.body));
const gatewayBody = gateway.body as GatewayResponse;

// 3. Read the merchandise records through the gateway.
const records = await post(
  `${gatewayBody.apiBaseUrl}/reads/records`,
  { view: { active: true, limit: 250, ordersLimit: 0, productSort: 'name', summary: true } },
  { authorization: `Bearer ${gatewayBody.token}`, 'x-ontos-composition-revision': revision },
);
assert.equal(records.status, 200, JSON.stringify(records.body));

// 4. Pick the product and compute the new price.
const product = (records.body as MerchandiseRecords).products
  .filter((entry) => entry.active && entry.currentPriceMinor >= 10_000 && (entry.variantSummary?.count ?? 0) === 0)
  .toSorted((left, right) => left.name.localeCompare(right.name, 'cs'))[0];
assert.ok(product, 'V Obchodní firmě chybí aktivní produkt bez variant s cenou alespoň 100 Kč');
const newPriceMinor = Math.round((product.currentPriceMinor * 1.05) / 100) * 100;
const czk = (minor: number) => new Intl.NumberFormat('cs-CZ', { currency: 'CZK', style: 'currency' }).format(minor / 100);
const taskTitle = `Informovat zákazníky o nové ceně: ${product.name}`.slice(0, 200);

// 5. Submit the batch: one price change and one task.
const submitted = await post(
  '/shell-super-app-api/agent-platform/proposals',
  {
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
  agentHeaders,
);
assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
const result = submitted.body as SubmitResponse;
console.log(
  `Připraveno: dávka ${result.batchId} (cena ${product.name} ${czk(product.currentPriceMinor)} → ${czk(newPriceMinor)} a nový úkol) čeká na schválení na ${shellUrl}${result.reviewPath}.`,
);
