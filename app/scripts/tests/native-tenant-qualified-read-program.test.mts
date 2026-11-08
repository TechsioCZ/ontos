import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'effect-rstest';

import { hasCompleteGeneratedModuleRead } from '../generated-governed-http-boundary.mts';

// Payment Term Catalog and Price Group Catalog publish the tenant-qualified read program shape: the load
// projects the trusted context into an owner-local `Effect.fn` generator and returns a native evidence map.
// The program's only executable dependency is the scoped service, guarded by the trusted tenant. These tests
// pin the full-source positives and the hostile negatives that must stay rejected.
const root = path.resolve(import.meta.dirname, '../..');
const sources = new Map<string, string>();
const excluded = new Set([
  '.cache',
  '.git',
  '.modern',
  '.output',
  'cloudflare-dist',
  'coverage',
  'dist',
  'node_modules',
]);
const collect = (directory: string): void => {
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!excluded.has(entry.name) && !entry.name.startsWith('dist')) {
        collect(file);
      }
    } else if (/\.(?:[cm]?[jt]sx?|json|md)$/u.test(entry.name)) {
      sources.set(file, readFileSync(path.join(root, file), 'utf-8'));
    }
  }
};
for (const directory of ['apps', 'verticals', 'packages']) {
  collect(directory);
}

interface ReadTarget {
  readonly moduleId: string;
  readonly name: string;
  readonly vertical: string;
}

const readFile = (target: ReadTarget): string => `verticals/${target.vertical}/src/api/${target.name}.read.ts`;

const accepts = (target: ReadTarget, source: string): boolean =>
  hasCompleteGeneratedModuleRead(
    new Map([...sources, [readFile(target), source]]),
    readFile(target),
    `verticals/${target.vertical}`,
    target.moduleId,
    target.name,
  );

const readSource = (target: ReadTarget): string => sources.get(readFile(target)) ?? '';

const paymentTerm = (name: string): ReadTarget => ({
  moduleId: 'payment.term-catalog',
  name,
  vertical: 'payment-term-catalog',
});
const priceGroup = (name: string): ReadTarget => ({
  moduleId: 'pricing.price-group-catalog',
  name,
  vertical: 'price-group-catalog',
});

const PAYMENT_TERM_HISTORY = 'payment-term-history';

const tenantQualifiedReads: readonly ReadTarget[] = [
  paymentTerm('current-payment-terms'),
  paymentTerm(PAYMENT_TERM_HISTORY),
  paymentTerm('payment-term-source-record-history'),
  paymentTerm('payment-term-source-statement'),
  priceGroup('price-group-definition'),
  priceGroup('validate-price-group-compatibility'),
];

const HISTORY_RESULT_BINDING = 'const history = historyOption.value;';
const HISTORY_LOAD_CALL = 'readPaymentTermHistory(input, context.scope.tenantId, context.services)';

it('accepts the actual tenant-qualified read programs for Payment Term Catalog and Price Group Catalog', () => {
  for (const target of tenantQualifiedReads) {
    expect(accepts(target, readSource(target)), readFile(target)).toBe(true);
  }
  // The Catalog product-detail read shares this top-level shape and must not regress.
  const productDetail: ReadTarget = { moduleId: 'commerce.catalog', name: 'product-detail', vertical: 'catalog' };
  expect(accepts(productDetail, readSource(productDetail))).toBe(true);
});

it('rejects executable service factories that do not produce an Effect', () => {
  const target = paymentTerm(PAYMENT_TERM_HISTORY);
  const original = readSource(target);
  for (const invalidFactory of ['() => 42', '() => null', '() => ({})', '() => []']) {
    const invalid = original.replace(
      '(transaction, scope) => paymentTermCatalogPersistenceForScope(transaction, scope)',
      invalidFactory,
    );
    expect(invalid).not.toBe(original);
    expect(accepts(target, invalid), invalidFactory).toBe(false);
  }
});

it('rejects hostile tenant, service, helper, Effect, factory, eager-effect and rebinding shapes', () => {
  const history = paymentTerm(PAYMENT_TERM_HISTORY);
  const historySource = readSource(history);
  const statement = paymentTerm('payment-term-source-statement');
  const statementSource = readSource(statement);
  const current = paymentTerm('current-payment-terms');
  const currentSource = readSource(current);
  const definition = priceGroup('price-group-definition');
  const definitionSource = readSource(definition);

  const historyMutations: readonly (readonly [string, ReadTarget, string])[] = [
    ['tenant guard flipped', history, historySource.replace('!== trustedTenantId', '=== trustedTenantId')],
    ['tenant guard foreign variable', history, historySource.replace('!== trustedTenantId', '!== someOtherTenant')],
    [
      'service method absent from the interface',
      history,
      historySource.replace('services.getHistory(', 'services.evilRead('),
    ],
    [
      'service parameter typed as a foreign persistence',
      history,
      historySource.replace('services: PaymentTermCatalogPersistence,', 'services: ForeignPersistence,'),
    ],
    [
      'helper body calls a method on the request input',
      history,
      historySource.replace(HISTORY_RESULT_BINDING, 'const history = input.frobnicate();'),
    ],
    ['helper body throws', history, historySource.replace(HISTORY_RESULT_BINDING, 'throw new Error("boom");')],
    [
      'helper body uses a mutable binding',
      history,
      historySource.replace(HISTORY_RESULT_BINDING, 'let history = historyOption.value;'),
    ],
    [
      'helper rebound from a foreign module',
      history,
      historySource
        .replace(
          "import type { ReadLoadContext } from '@app/core-runtime';",
          "import type { ReadLoadContext } from '@app/core-runtime';\nimport { readPaymentTermHistoryFromPackage } from '@app/payment-term-catalog-contracts/history';",
        )
        .replace(
          HISTORY_LOAD_CALL,
          'readPaymentTermHistoryFromPackage(input, context.scope.tenantId, context.services)',
        ),
    ],
    [
      'load forwards a foreign service',
      history,
      historySource.replace(
        HISTORY_LOAD_CALL,
        'readPaymentTermHistory(input, context.scope.tenantId, context.foreign)',
      ),
    ],
    [
      'load forwards the scope record instead of the service',
      history,
      historySource.replace(HISTORY_LOAD_CALL, 'readPaymentTermHistory(input, context.scope.tenantId, context.scope)'),
    ],
    [
      'load context declares a different service type',
      history,
      historySource.replace('ReadLoadContext<PaymentTermCatalogPersistence>', 'ReadLoadContext<ForeignPersistence>'),
    ],
    [
      'foreign package import smuggled in',
      history,
      historySource.replace(
        "import type { ReadLoadContext } from '@app/core-runtime';",
        "import type { ReadLoadContext } from '@app/core-runtime';\nimport { evil } from 'evil-pkg';",
      ),
    ],
    [
      'scoped factory replaced by an arbitrary binding',
      history,
      historySource.replace(
        '(transaction, scope) => paymentTermCatalogPersistenceForScope(transaction, scope)',
        'foreignPersistence',
      ),
    ],
    [
      'eager hidden effect outside the yield pipeline',
      history,
      historySource.replace(
        'const historyOption = yield* services.getHistory(',
        'const leaked = Effect.runPromise(services.getHistory(input.paymentTermRef.resourceId));\n  const historyOption = yield* services.getHistory(',
      ),
    ],
    [
      'scoped service rebound',
      history,
      historySource.replace(
        'const historyOption = yield* services.getHistory(',
        'services = undefined as never;\n  const historyOption = yield* services.getHistory(',
      ),
    ],
    [
      'Effect runtime shadowed',
      history,
      historySource.replace(
        "import { DateTime, Effect, Option, Schema } from 'effect';",
        "import { DateTime, Effect, Option, Schema } from 'effect';\nconst Effect = { runPromise: () => undefined };",
      ),
    ],
    [
      'load forwards an extra argument',
      statement,
      statementSource.replace(
        'readPaymentTermSourceStatement(input, context.services)',
        'readPaymentTermSourceStatement(input, context.services, context.scope.tenantId)',
      ),
    ],
    [
      'nested helper receives a foreign service',
      current,
      currentSource.replace(
        'preserveRequestedSemanticRevision(request, trustedTenantId, outcome, services)',
        'preserveRequestedSemanticRevision(request, trustedTenantId, outcome, foreignServices)',
      ),
    ],
    [
      'nested helper call replaced by a foreign predicate',
      current,
      currentSource.replace(
        'isPersistenceId(request.paymentTermRef.resourceId)',
        'foreignPredicate(request.paymentTermRef.resourceId)',
      ),
    ],
    [
      'helper is not a generator program',
      definition,
      definitionSource.replace(
        "export const readPriceGroupDefinition = Effect.fn('PriceGroupDefinitionRead.read')(",
        'export const readPriceGroupDefinition = (',
      ),
    ],
  ];

  for (const [label, target, mutated] of historyMutations) {
    expect(mutated, `${label}: mutation must change the source`).not.toBe(readSource(target));
    expect(accepts(target, mutated), label).toBe(false);
  }
});
