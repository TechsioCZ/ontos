import { FinanceCompanyIdSchema } from '../../shared/apis/records.ts';
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { ChildProcess } from 'effect/process';
import { expect, it } from 'effect-rstest';
import { Config, ConfigProvider, Crypto, DateTime, Effect, FileSystem, Layer, Path, Schema, Stream } from 'effect';
import { Hex } from 'effect/encoding';
import { ApplyCommandPayloadSchema, FinanceCommandSchema } from '../../shared/actions/apply-command.ts';
import type { FinanceState, Invoice } from '../../shared/apis/records.ts';
import { transitionFinance } from '../../src/services/persistence.service.ts';
import type { ExportPartnerReference, FinanceValidators } from '../../src/services/persistence.service.ts';

const tenantId = 'a0000000-0000-4000-8000-000000000001';
const scope = { legalEntityId: 'a0000000-0000-4000-8000-000000000002', tenantId };
const now = DateTime.makeUnsafe('2026-10-20T08:00:00Z');
/** What the action resolves server-side: the legal entity name from Core and partners from the party registry. */
const trustedReferences = (
  issuerName: string,
  partners: Readonly<Record<string, ExportPartnerReference>> = {},
): FinanceValidators => ({
  exportReferences: Effect.succeed({ issuerName, partners: new Map(Object.entries(partners)) }),
  invoice: () => Effect.void,
});
const counterpartyRef = {
  moduleId: 'party.registry' as const,
  resourceId: 'a0000000-0000-4000-8000-000000000012',
  resourceType: 'party.registry.counterparty' as const,
  tenantId,
};
const invoice = (id: string, overrides: Partial<Invoice> = {}): Invoice => ({
  accountingCorrelation: `acc-${id}`,
  accountingSyncState: 'NOT_SYNCED',
  businessState: 'CONFIRMED',
  counterpartyRef,
  createdAt: now,
  currency: 'CZK',
  direction: 'OUTGOING',
  documentNumber: id,
  dueDate: '2026-10-30',
  issueDate: '2026-10-01',
  paidMinor: 0,
  paymentState: 'UNPAID',
  ref: {
    moduleId: 'finance.billing',
    resourceId: id,
    resourceType: 'finance.billing.invoice',
    tenantId,
  },
  totalMinor: 100_000,
  updatedAt: now,
  ...overrides,
});
const empty: FinanceState = {
  financialPlanEntries: [],
  invoices: [],
};
let counter = 0;
const run = (
  state: FinanceState,
  command: typeof FinanceCommandSchema.Encoded,
  validators = trustedReferences('Siampark'),
) => {
  counter += 1;
  const execution = {
    attemptId: `attempt-${counter}`,
    now,
    principalId: 'principal-1',
    resourceId: `resource-${counter}`,
  };
  return Schema.decodeEffect(FinanceCommandSchema)(command).pipe(
    Effect.flatMap((decoded) => transitionFinance(state, decoded, scope, validators, execution)),
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnvRecord({ ONTOS_GATEWAY_ISSUER: 'https://shell.example.test' }),
    ),
  );
};
/** Official STORMWARE dataPack 2.0 schemas are supplied outside the repository. */
const validateAgainstXsd = Effect.fn('FinanceTest.validatePohodaXsd')(function* validateAgainstXsd(xml: string) {
  const directory = yield* Config.String('POHODA_XSD_DIR').pipe(
    Config.withDefault('/Volumes/DevWork/agent-scratch/pohoda-xsd/download'),
  );
  const path = yield* Path.Path;
  const xsd = path.join(directory, 'data.xsd');
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(xsd))) {
    yield* Effect.logWarning(`POHODA XSD not found at ${xsd}; schema validation skipped`);
    return;
  }
  const validation = yield* ChildProcess.make('/usr/bin/xmllint', ['--noout', '--schema', xsd, '-'], {
    stderr: 'inherit',
    stdin: Stream.make(new TextEncoder().encode(xml)),
    stdout: 'ignore',
  });
  expect(yield* validation.exitCode).toBe(0);
});

const issued = invoice('fv-1', {
  counterpartyName: 'Ateliér Horák s.r.o.',
  documentNumber: 'FV-2026-0004',
  lines: [{ description: 'Nájem 09/2026', quantity: 1, unitPriceMinor: 2_500_000, vatRate: 21 }],
  number: 'FV-2026-0004',
  subtotalMinor: 2_500_000,
  totalMinor: 3_025_000,
  vatMinor: 525_000,
  vatRecap: [{ baseMinor: 2_500_000, rate: 21, vatMinor: 525_000 }],
});
const received = invoice('pf-1', {
  counterpartyCompanyId: Schema.decodeSync(FinanceCompanyIdSchema)('47116617'),
  counterpartyName: 'Kooperativa pojišťovna, a.s.',
  // Hand-typed supplier: no registry party, the IČO snapshot on the invoice is the partner identity.
  counterpartyRef: { ...counterpartyRef, resourceId: '00000000-0000-4000-8000-000000000000' },
  direction: 'INCOMING',
  documentNumber: '7720115',
  dueDate: '2026-10-04',
  issueDate: '2026-09-20',
  totalMinor: 3_120_000,
});

it.layer(Layer.merge(NodeServices.layer, NodeCrypto.layer))('S08 POHODA XML handover end-to-end', (test) => {
  test.effect('Siampark: setup IČO + session name + registry partner become a valid, hashed, versioned dataPack', () =>
    Effect.gen(function* siampark() {
      const configured = yield* run(
        { ...empty, invoices: [issued, received] },
        {
          _tag: 'UpdateAccountingSetup',
          issuerCity: 'Praha',
          issuerIco: '12345678',
          issuerVatId: 'CZ12345678',
          product: 'POHODA',
        },
      );
      const result = yield* run(
        configured.state,
        {
          _tag: 'CreateAccountingExport',
          actorLabel: 'Finance (finance@siampark.demo)',
          format: 'POHODA_XML',
          invoiceResourceIds: ['fv-1', 'pf-1'],
        },
        trustedReferences('Siampark', {
          [counterpartyRef.resourceId]: { city: 'Praha', ico: '27082440', vatId: 'CZ27082440' },
        }),
      );
      const created = result.state.accountingExports?.[0];
      expect(created?.fileName).toBe('UP-2026-001-v1.xml');
      expect(created?.format).toBe('POHODA_XML');
      expect(created?.status).toBe('PREPARED');
      expect(created?.issuerName).toBe('Siampark');
      expect(created?.issuerIco).toBe('12345678');
      const content = created?.content ?? '';
      const crypto = yield* Crypto.Crypto;
      const digest = yield* crypto.digest('SHA-256', new TextEncoder().encode(content));
      expect(created?.sha256).toBe(Hex.encode(digest));
      expect(content).toContain('id="UP-2026-001-v1" ico="12345678"');
      expect(content).toContain('<typ:company>Siampark</typ:company>');
      expect(content).toContain('<typ:dic>CZ12345678</typ:dic>');
      expect(content).toContain('<typ:company>Ateliér Horák s.r.o.</typ:company>');
      expect(content).toContain('<typ:ico>27082440</typ:ico>');
      expect(content).toContain('<typ:ico>47116617</typ:ico>');
      expect(content).toContain('<typ:priceHighVAT>5250.00</typ:priceHighVAT>');
      expect(content).toContain('<inv:invoiceType>receivedInvoice</inv:invoiceType>');
      expect(content).not.toContain('SIMULACE');
      // S08-03: a handover never marks invoices as booked.
      expect(result.state.invoices.every((entry) => entry.accountingSyncState === 'NOT_SYNCED')).toBe(true);
      yield* validateAgainstXsd(content);
    }),
  );

  test.effect('Obchodní firma without an IČO: issuer is the selected company name, no ico attribute, still valid', () =>
    Effect.gen(function* obchod() {
      const result = yield* run(
        { ...empty, invoices: [issued] },
        {
          _tag: 'CreateAccountingExport',
          actorLabel: 'Účetní (ucetni@demo.ontos)',
          format: 'POHODA_XML',
          invoiceResourceIds: ['fv-1'],
        },
        trustedReferences('Obchodní firma'),
      );
      const created = result.state.accountingExports?.[0];
      expect(created?.issuerName).toBe('Obchodní firma');
      expect(created?.issuerIco).toBeUndefined();
      expect(created?.content).not.toContain(' ico="');
      expect(created?.content).toContain('<typ:company>Obchodní firma</typ:company>');
      yield* validateAgainstXsd(created?.content ?? '');
    }),
  );

  test.effect('browser-sent issuer, partner and author fields cannot reach the file', () =>
    Effect.gen(function* forged() {
      const payload = yield* Schema.decodeUnknownEffect(ApplyCommandPayloadSchema)({
        command: {
          _tag: 'CreateAccountingExport',
          actorLabel: 'Účetní (ucetni@demo.ontos)',
          counterparties: { 'fv-1': { ico: '12345678' } },
          counterpartyNames: { 'fv-1': 'Podvržená s.r.o.' },
          format: 'POHODA_XML',
          host: 'untrusted.example.test',
          invoiceResourceIds: ['fv-1'],
          issuerName: 'Obchodní firma',
          shellOrigin: 'https://untrusted.example.test',
        },
        expectedRevision: 0,
      });
      expect(Object.keys(payload.command)).not.toContain('issuerName');
      expect(Object.keys(payload.command)).not.toContain('counterparties');
      expect(Object.keys(payload.command)).not.toContain('host');
      expect(Object.keys(payload.command)).not.toContain('shellOrigin');
      const result = yield* run({ ...empty, invoices: [issued] }, payload.command, trustedReferences('Siampark'));
      const content = result.state.accountingExports?.[0]?.content ?? '';
      expect(content).toContain('<typ:company>Siampark</typ:company>');
      expect(content).not.toContain('Obchodní firma');
      expect(content).not.toContain('12345678');
      // The file names the authenticated principal, not the readable label the browser sent.
      expect(content).toContain('vytvořil uživatel OntOS principal-1');
      expect(content).not.toContain('ucetni@demo.ontos');
      expect(content).toContain('https://shell.example.test/cs/finance?resourceId=fv-1');
      expect(content).not.toContain('untrusted.example.test');
      yield* validateAgainstXsd(content);
    }),
  );
});
