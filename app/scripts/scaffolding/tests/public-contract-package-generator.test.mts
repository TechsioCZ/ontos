import { NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { hasCompleteGeneratedModuleApiSeam } from '../../generated-governed-http-boundary.mts';
import { planGovernedContributionScaffold } from '../governed-contribution/scaffold.mts';

const appRoot = path.resolve(import.meta.dirname, '../../..');
const paymentVerticalPath = 'verticals/payment-term-catalog';
const publicContractPackagePath = 'packages/payment-term-catalog-contracts';
const sharedApiFile = `${paymentVerticalPath}/shared/api.ts`;
const packageManifestFile = `${publicContractPackagePath}/package.json`;
const canonicalContractFile = `${publicContractPackagePath}/src/apis/current-payment-terms.ts`;
const canonicalClientFile = `${publicContractPackagePath}/src/api/current-payment-terms-client.ts`;
const canonicalGatewayFile = `${publicContractPackagePath}/src/api/action-gateway.ts`;
const ownerContractFile = `${paymentVerticalPath}/shared/apis/current-payment-terms.ts`;
const ownerClientFile = `${paymentVerticalPath}/src/api/current-payment-terms-client.ts`;
const governedContractFiles = [
  canonicalClientFile,
  canonicalContractFile,
  canonicalGatewayFile,
  ownerClientFile,
  ownerContractFile,
] as const;
const customerVerticalPath = 'verticals/commerce-customer-context';
const customerContractPackagePath = 'packages/customer-payment-term-contracts';
const customerSharedApiFile = `${customerVerticalPath}/shared/api.ts`;
const customerOwnerContractFile = `${customerVerticalPath}/shared/apis/payment-term-affected-use-assessment.ts`;
const customerOwnerClientFile = `${customerVerticalPath}/src/api/payment-term-affected-use-assessment-client.ts`;
const customerCanonicalContractFile = `${customerContractPackagePath}/src/apis/payment-term-affected-use-assessment.ts`;
const customerCanonicalClientFile = `${customerContractPackagePath}/src/api/payment-term-affected-use-assessment-client.ts`;
const customerCanonicalGatewayFile = `${customerContractPackagePath}/src/api/action-gateway.ts`;
const customerGovernedContractFiles = [
  customerCanonicalClientFile,
  customerCanonicalContractFile,
  customerCanonicalGatewayFile,
  customerOwnerClientFile,
  customerOwnerContractFile,
] as const;

const readSourceTree = async (relativeDirectory: string, sources: Map<string, string>): Promise<void> => {
  const absoluteDirectory = path.join(appRoot, relativeDirectory);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      if (['.modern-js', 'dist', 'node_modules'].includes(entry.name)) {
        return;
      }
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        await readSourceTree(relativePath, sources);
      } else if (entry.isFile() && (relativePath.endsWith('.json') || relativePath.endsWith('.ts'))) {
        sources.set(relativePath, await readFile(path.join(appRoot, relativePath), 'utf-8'));
      }
    }),
  );
};

const loadPaymentContractSources = (): Promise<Map<string, string>> => {
  const sources = new Map<string, string>();
  return Promise.all([
    readSourceTree(paymentVerticalPath, sources),
    readSourceTree(publicContractPackagePath, sources),
  ]).then(() => sources);
};

const loadCustomerContractSources = (): Promise<Map<string, string>> => {
  const sources = new Map<string, string>();
  return Promise.all([
    readSourceTree(customerVerticalPath, sources),
    readSourceTree(customerContractPackagePath, sources),
    readSourceTree(publicContractPackagePath, sources),
  ]).then(() => sources);
};

const focusOnCustomerAffectedUseSeam = (sources: ReadonlyMap<string, string>): ReadonlyMap<string, string> => {
  const focused = new Map(
    [...sources].filter(
      ([file]) => !file.startsWith(`${customerVerticalPath}/shared/apis/`) || file === customerOwnerContractFile,
    ),
  );
  for (const [file, start, end] of [
    [
      `${customerVerticalPath}/vertical.manifest.ts`,
      '// <generated-module-manifest-apis>',
      '// </generated-module-manifest-apis>',
    ],
    [
      `${customerVerticalPath}/vertical.registration.ts`,
      '// <generated-module-registration-apis>',
      '// </generated-module-registration-apis>',
    ],
  ] as const) {
    const source = focused.get(file);
    if (source === undefined) {
      continue;
    }
    let insideSlot = false;
    let keepTargetEntry = false;
    focused.set(
      file,
      source
        .split('\n')
        .filter((line) => {
          if (line.includes(start)) {
            insideSlot = true;
            return true;
          }
          if (line.includes(end)) {
            insideSlot = false;
            return true;
          }
          if (!insideSlot) {
            return true;
          }
          if (line.includes("'payment-term-affected-use-assessment'")) {
            keepTargetEntry = !line.trimEnd().endsWith(',');
            return true;
          }
          if (keepTargetEntry) {
            keepTargetEntry = !line.trimEnd().endsWith(',');
            return true;
          }
          return false;
        })
        .join('\n'),
    );
  }
  return focused;
};

const expectsCompletePaymentSeam = (sources: ReadonlyMap<string, string>): boolean =>
  hasCompleteGeneratedModuleApiSeam(sources, sharedApiFile, 'payment-term-catalog');

it.effect(
  'accepts the Payment-owned companion contract package as an idempotent module API scaffold',
  Effect.fn(function* publicContractPackageIdempotence() {
    const before = yield* Effect.promise(loadPaymentContractSources);
    const plan = yield* planGovernedContributionScaffold(appRoot, 'module-api', {
      authorization: 'context_permission',
      name: 'current-payment-terms',
      permission: 'payment.term_catalog.read',
      vertical: 'payment-term-catalog',
    }).pipe(Effect.provide(NodeServices.layer));
    const after = yield* Effect.promise(loadPaymentContractSources);

    expect(plan.mutations).toEqual([]);
    expect(governedContractFiles.map((file) => after.get(file))).toEqual(
      governedContractFiles.map((file) => before.get(file)),
    );
    expect(plan.result).toEqual({
      artifactPath: path.join(appRoot, ownerContractFile),
      clientPath: path.join(appRoot, paymentVerticalPath, 'src/api/current-payment-terms-client.ts'),
      serverPath: path.join(appRoot, paymentVerticalPath, 'api/current-payment-terms-read-server.ts'),
    });
    expect(expectsCompletePaymentSeam(after)).toBe(true);
  }),
);

it.live(
  'rejects canonical companion contract and client drift at the complete module API seam',
  Effect.fn(function* publicContractDrift() {
    const valid = yield* Effect.promise(loadPaymentContractSources);
    expect(expectsCompletePaymentSeam(valid)).toBe(true);

    const wrongEndpoint = new Map([
      ...valid,
      [
        canonicalContractFile,
        valid.get(canonicalContractFile)?.replace('/reads/current-payment-terms', '/reads/not-current-payment-terms') ??
          '',
      ],
    ]);
    expect(expectsCompletePaymentSeam(wrongEndpoint)).toBe(false);

    const wrongAudience = new Map([
      ...valid,
      [
        canonicalClientFile,
        valid.get(canonicalClientFile)?.replace('/payment-term-catalog-api', '/customer-context-api') ?? '',
      ],
    ]);
    expect(expectsCompletePaymentSeam(wrongAudience)).toBe(false);

    const handwrittenOwnerFacade = new Map([
      ...valid,
      [ownerContractFile, `${valid.get(ownerContractFile) ?? ''}\nexport const unsafeOwnerExtension = true;\n`],
    ]);
    expect(expectsCompletePaymentSeam(handwrittenOwnerFacade)).toBe(false);
  }),
);

it.effect(
  'accepts the Customer-owned affected-use companion package as an idempotent module API scaffold',
  Effect.fn(function* customerPublicContractPackageIdempotence() {
    const before = yield* Effect.promise(loadCustomerContractSources);
    const plan = yield* planGovernedContributionScaffold(appRoot, 'module-api', {
      authorization: 'context_permission',
      name: 'payment-term-affected-use-assessment',
      permission: 'payment.term_catalog.read',
      vertical: 'commerce-customer-context',
    }).pipe(Effect.provide(NodeServices.layer));
    const after = yield* Effect.promise(loadCustomerContractSources);

    expect(plan.mutations).toEqual([]);
    expect(customerGovernedContractFiles.map((file) => after.get(file))).toEqual(
      customerGovernedContractFiles.map((file) => before.get(file)),
    );
    expect(plan.result).toEqual({
      artifactPath: path.join(appRoot, customerOwnerContractFile),
      clientPath: path.join(appRoot, customerVerticalPath, 'src/api/payment-term-affected-use-assessment-client.ts'),
      serverPath: path.join(appRoot, customerVerticalPath, 'api/payment-term-affected-use-assessment-read-server.ts'),
    });
    expect(
      hasCompleteGeneratedModuleApiSeam(
        focusOnCustomerAffectedUseSeam(after),
        customerSharedApiFile,
        'commerce-customer-context',
      ),
    ).toBe(true);
  }),
);

it.live(
  'rejects a companion package whose ownership metadata no longer matches the Payment module',
  Effect.fn(function* publicContractOwnership() {
    const valid = yield* Effect.promise(loadPaymentContractSources);
    const manifest = valid.get(packageManifestFile);
    if (manifest === undefined) {
      expect.unreachable(`expected ${packageManifestFile}`);
    }

    for (const invalidManifest of [
      manifest.replace('"appId": "payment-term-catalog"', '"appId": "commerce-customer-context"'),
      manifest.replace('"moduleId": "payment.term-catalog"', '"moduleId": "commerce.customer-context"'),
      manifest.replace('"packageName": "@app/payment-term-catalog"', '"packageName": "@app/commerce-customer-context"'),
      manifest.replace('"current-payment-terms"', '"unrelated-api"'),
    ]) {
      const sources = new Map([...valid, [packageManifestFile, invalidManifest]]);
      expect(expectsCompletePaymentSeam(sources)).toBe(false);
    }
  }),
);
