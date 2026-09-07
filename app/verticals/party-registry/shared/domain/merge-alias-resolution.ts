import type { PartyAliasResolutionBrokenChain } from './merge-alias-resolution-errors/broken-chain.ts';
import type { PartyAliasResolutionCrossTenant } from './merge-alias-resolution-errors/cross-tenant.ts';
import type { PartyAliasResolutionCycle } from './merge-alias-resolution-errors/cycle.ts';
import type { PartyAliasResolutionUnavailable } from './merge-alias-resolution-errors/unavailable.ts';

export { PartyAliasResolutionBrokenChain } from './merge-alias-resolution-errors/broken-chain.ts';
export { PartyAliasResolutionCrossTenant } from './merge-alias-resolution-errors/cross-tenant.ts';
export { PartyAliasResolutionCycle } from './merge-alias-resolution-errors/cycle.ts';
export { PartyAliasResolutionUnavailable } from './merge-alias-resolution-errors/unavailable.ts';
export { PartyAliasWriteRejected } from './merge-alias-resolution-errors/write-rejected.ts';

export type PartyAliasResolutionError =
  | PartyAliasResolutionBrokenChain
  | PartyAliasResolutionCrossTenant
  | PartyAliasResolutionCycle
  | PartyAliasResolutionUnavailable;
