const principalImport =
  "import { ActionPrincipalVerifierLive as GovernedActionPrincipalVerifierLive } from './auth/action-principal.ts';";
const redemptionImport =
  "import { GatewayAssertionRedemptionLive as GovernedGatewayAssertionRedemptionLive } from './auth/gateway-assertion-redemption.ts';";

export const governedSupportImports = [principalImport, redemptionImport] as const;
type GovernedSupportImport = (typeof governedSupportImports)[number];

const supportedImports = [
  [principalImport, principalImport],
  [redemptionImport, redemptionImport],
  [
    "import { GatewayAssertionRedemptionLive as GovernedGatewayAssertionRedemptionLive, GatewayAssertionRedemptionDatabaseLive } from './auth/gateway-assertion-redemption.ts';",
    redemptionImport,
  ],
  [
    "import { GatewayAssertionRedemptionLive as GovernedGatewayAssertionRedemptionLive, GatewayAssertionRedemptionDatabaseLive, GatewayAssertionPgClientLive } from './auth/gateway-assertion-redemption.ts';",
    redemptionImport,
  ],
] as const;

/** Formatting and binding order do not change the exact supported module and binding set. */
const importIdentity = (candidate: string): string | undefined => {
  const match = /^import\s*\{(?<bindings>[^}]+)\}\s*from\s*'(?<module>[^']+)'\s*;$/u.exec(candidate);
  if (match?.groups === undefined) {
    return undefined;
  }
  const bindings = (match.groups['bindings'] ?? '')
    .split(',')
    .map((binding) => binding.trim().replaceAll(/\s+/gu, ' '))
    .filter(Boolean)
    .toSorted();
  return `${match.groups['module']}:${bindings.join(',')}`;
};

export const governedSupportImportOwner = (candidate: string): GovernedSupportImport | undefined => {
  const identity = importIdentity(candidate);
  return supportedImports.find(([entry]) => identity !== undefined && importIdentity(entry) === identity)?.[1];
};

const principal = 'GovernedActionPrincipalVerifierLive';
const actionPrincipal = `${principal}.pipe(GovernedReadLayer.provide(governedActionRuntimeLive))`;
const redemption = 'GovernedGatewayAssertionRedemptionLive';
const databaseRedemption = `${redemption}.pipe(GovernedReadLayer.provide(GatewayAssertionRedemptionDatabaseLive))`;
const pgRedemption =
  `${redemption}.pipe(GovernedReadLayer.provide(GatewayAssertionRedemptionDatabaseLive),` +
  'GovernedReadLayer.provide(GatewayAssertionPgClientLive),GovernedReadLayer.provide(Reactivity.layer))';
const support = (verifier: string, store: string) =>
  `GovernedReadLayer.provide(GovernedReadLayer.mergeAll(${verifier}, ${store})),`;

export const governedReadSupport = support(principal, redemption);
export const governedActionSupport = support(actionPrincipal, redemption);
export const governedDatabaseSupport = support(actionPrincipal, databaseRedemption);
export const governedPgClientSupport = support(actionPrincipal, pgRedemption);
const supportedLayers = [
  governedReadSupport,
  governedActionSupport,
  governedDatabaseSupport,
  governedPgClientSupport,
] as const;

/** These layer expressions contain no text literals. Ignore only whitespace and formatter-added trailing commas. */
const layerIdentity = (candidate: string) => candidate.replaceAll(/\s+/gu, '').replaceAll(/,(?=\))/gu, '');

export const isGovernedSupportLayer = (candidate: string): boolean =>
  supportedLayers.some((entry) => layerIdentity(entry) === layerIdentity(candidate));
