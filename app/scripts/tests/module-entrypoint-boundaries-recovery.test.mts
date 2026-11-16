import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  hasCompleteGeneratedModuleApiSeam,
  hasPublishedGeneratedContractShim,
} from '../generated-governed-http-boundary.mts';
import { hasGeneratedModuleApiReadContract } from '../generated-module-api-boundary.mts';
import {
  CUSTOMER_CONTEXT_DEPLOYMENT_ID,
  CUSTOMER_CONTEXT_VERTICAL_PATH,
  MODULE_API_HEADER,
  SHARED_CONTRACTS_PACKAGE_JSON_PATH,
  readPricingSourceTree,
} from './module-entrypoint-boundaries.fixture.mts';

it.live('accepts actual CCC named recovery reexports and rejects provenance or executable escapes', () =>
  Effect.gen(function* actualNamedCustomerContextRecovery() {
    const root = path.resolve(import.meta.dirname, '../..');
    const owner = CUSTOMER_CONTEXT_VERTICAL_PATH;
    const deployment = path.posix.basename(owner);
    const [trees, metadata] = yield* Effect.all([
      Effect.all(
        [
          `${owner}/api`,
          `${owner}/shared`,
          `${owner}/src`,
          'packages/customer-market-retirement-contracts',
          'packages/customer-payment-term-contracts',
        ].map((folder) => readPricingSourceTree(root, folder)),
      ),
      Effect.all(
        [
          `${owner}/package.json`,
          `${owner}/vertical.manifest.ts`,
          `${owner}/vertical.registration.ts`,
          SHARED_CONTRACTS_PACKAGE_JSON_PATH,
          'packages/shared-contracts/src/external-identity-client.ts',
        ].map((file) =>
          Effect.promise(() => readFile(path.join(root, file), 'utf-8')).pipe(
            Effect.map((source) => [file, source] as const),
          ),
        ),
      ),
    ]);
    const sources = new Map([...trees.flat(), ...metadata]);
    const shared = `${owner}/shared/api.ts`;
    const contractFile = `${owner}/shared/apis/market-retirement-reservation-recovery.ts`;
    const clientFile = `${owner}/src/api/market-retirement-reservation-recovery-client.ts`;
    const contractSpecifier = '@app/customer-market-retirement-contracts/market-retirement-reservation-recovery';
    const contract = sources.get(contractFile) ?? '';
    const client = sources.get(clientFile) ?? '';
    for (const shim of [contract, client]) {
      expect(shim).toContain('export {');
      expect(shim).toContain('export type {');
    }
    expect(hasPublishedGeneratedContractShim(sources, contractFile, contract)).toBe(true);
    const inlineType = `${MODULE_API_HEADER}// @ontos-public-contract ${contractSpecifier}\nexport { MarketRetirementReservationRecoveryApi, type MarketRetirementReservationRecoveryRequest } from '${contractSpecifier}';\n`;
    expect(hasPublishedGeneratedContractShim(sources, contractFile, inlineType)).toBe(true);
    const diagnostics: string[] = [];
    expect(hasCompleteGeneratedModuleApiSeam(sources, shared, deployment, diagnostics), diagnostics.join('\n')).toBe(
      true,
    );

    const icoReadFile = `${owner}/src/api/organization-customer-profile-ico.read.ts`;
    const icoRead = sources.get(icoReadFile) ?? '';
    expect(
      hasGeneratedModuleApiReadContract(icoRead, 'commerce.customer-context', 'organization-customer-profile-ico'),
    ).toBe(true);
    for (const invalid of [
      icoRead.replace(
        "const readKey = 'commerce.customer-context.api.organization-customer-profile-ico'",
        "const readKey = 'commerce.customer-context.api.foreign-read'",
      ),
      icoRead.replace("const ownerModuleKey = 'commerce.customer-context'", "const ownerModuleKey = 'foreign.owner'"),
      icoRead.replace('const readKey =', 'let readKey ='),
      icoRead.replace('    readKey,', "    readKey, readKey: 'commerce.customer-context.api.foreign-read',"),
    ]) {
      expect(invalid).not.toBe(icoRead);
      expect(
        hasGeneratedModuleApiReadContract(invalid, 'commerce.customer-context', 'organization-customer-profile-ico'),
      ).toBe(false);
      expect(hasCompleteGeneratedModuleApiSeam(new Map([...sources, [icoReadFile, invalid]]), shared, deployment)).toBe(
        false,
      );
    }
    const manifestFile = `${owner}/vertical.manifest.ts`;
    const manifest = sources.get(manifestFile) ?? '';
    const actionEntry = "'reserve-market-retirement-action': ReserveMarketRetirementActionApi,";
    const invalidActionMetadata = [
      manifest.replace(actionEntry, ''),
      manifest.replace(actionEntry, `${actionEntry}\n${actionEntry}`),
      manifest.replace(actionEntry, "'reserve-market-retirement-action': UnownedActionApi,"),
      manifest.replace(
        "operationKey: 'reserveMarketRetirementAction.execute'",
        "operationKey: 'foreignAction.execute'",
      ),
      manifest.replace(
        'registration: reserveMarketRetirementAction,',
        'registration: reservePaymentTermRetirementAction,',
      ),
      manifest.replace(
        "from './shared/apis/reserve-market-retirement-action.ts'",
        "from './shared/apis/foreign-action.ts'",
      ),
      manifest.replace("apiKey: 'reserve-market-retirement-action'", "apiKey: 'unpublished-action'"),
    ];
    for (const invalid of invalidActionMetadata) {
      expect(invalid).not.toBe(manifest);
      expect(
        hasCompleteGeneratedModuleApiSeam(
          new Map([...sources, [manifestFile, invalid]]),
          shared,
          CUSTOMER_CONTEXT_DEPLOYMENT_ID,
        ),
      ).toBe(false);
    }
    const registrationFile = `${owner}/vertical.registration.ts`;
    const registration = sources.get(registrationFile) ?? '';
    const withActionBrowserClient = registration.replace(
      '// <generated-module-registration-apis>',
      "// <generated-module-registration-apis>\n'reserve-market-retirement-action': () => import('./src/api/reserve-market-retirement-action-client.ts'),",
    );
    expect(
      hasCompleteGeneratedModuleApiSeam(
        new Map([...sources, [registrationFile, withActionBrowserClient]]),
        shared,
        CUSTOMER_CONTEXT_DEPLOYMENT_ID,
      ),
    ).toBe(false);
    const marker = `${MODULE_API_HEADER}// @ontos-public-contract ${contractSpecifier}\n`;
    for (const invalid of [
      contract.replaceAll(`from '${contractSpecifier}'`, "from '@app/wrong-contracts/recovery'"),
      contract.replaceAll(`from '${contractSpecifier}'`, "from '../../src/private.ts'"),
      `${contract}\nexport type { Other } from '@app/wrong-contracts/recovery';`,
      `${contract}\nexport const injected = true;`,
      `${contract}\nexport { injected };`,
      `${contract}\nexecutePrivateOperation();`,
      `import { injected } from './private.ts';\n${contract}`,
      `${marker}export * as namespace from '${contractSpecifier}';`,
      `${marker}export {} from '${contractSpecifier}';`,
      `${marker}export { Injected as Original } from '${contractSpecifier}';`,
      `${marker}export { Injected } from \`${contractSpecifier}\`;`,
      contract.replace(`// @ontos-public-contract ${contractSpecifier}\n`, ''),
    ]) {
      expect(invalid).not.toBe(contract);
      expect(hasPublishedGeneratedContractShim(sources, contractFile, invalid)).toBe(false);
    }
    // Full owner integration for both source paths; the shared classifier above covers each grammar escape.
    for (const [file, invalid] of [
      [contractFile, `${contract}\nexecutePrivateOperation();`],
      [clientFile, client.replaceAll(`from '${contractSpecifier}/client'`, "from '@app/wrong-contracts/recovery'")],
    ]) {
      expect(invalid).not.toBe(sources.get(file));
      const changed = new Map([...sources, [file, invalid]]);
      expect(hasCompleteGeneratedModuleApiSeam(changed, shared, deployment)).toBe(false);
    }
  }),
);
