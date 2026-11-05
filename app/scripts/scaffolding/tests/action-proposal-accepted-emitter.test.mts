/**
 * O85: a generated Action HTTP contract answers a parked proposal with **202 on the success channel**.
 *
 * The 202 body is Core's `ActionProposalAcceptedSchema` (imported and re-exported, never re-declared,
 * so the wire shape has one owner), the endpoint's `success` becomes a union only where a proposal can
 * actually be parked, and the signal never becomes a Problem Details body or a `mapCoreProblem` case.
 *
 * The transport capability is derived from the **registered declaration**, not restated as a flag: the
 * fixtures below are declaration fragments, and `renderActionHttpArtifacts` is the exact rendering the
 * scaffold plan writes for that declaration.
 */
import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { isProposableActionDeclaration, renderActionHttpArtifacts } from '../action-http/scaffold.mts';
import type { ActionProposalDeclaration } from '../action-http/scaffold.mts';
import type { OntosVerticalMetadata } from '../shared.mts';

const vertical = (): OntosVerticalMetadata => ({
  appId: 'inventory-app',
  directory: '/workspace/verticals/inventory-stock',
  manifestContent: '',
  manifestPath: '/workspace/verticals/inventory-stock/vertical.manifest.ts',
  moduleId: 'inventory.stock',
  packageContent: '{}',
  packageJson: {},
  packageName: '@app/inventory-stock',
  packagePath: '/workspace/verticals/inventory-stock/package.json',
  registrationContent: '',
  registrationPath: '/workspace/verticals/inventory-stock/vertical.registration.ts',
  slug: 'inventory-stock',
  topologyEntry: {},
});

/** The declaration fragment Codesmith emits for a proposable Action. */
const proposableDeclaration: ActionProposalDeclaration = { modes: ['run', 'propose', 'approve'] };

/**
 * Declarations that can never park a proposal: run-only, ephemeral (run-only by construction, O22), an
 * ephemeral declaration that also claims `propose`, and an Action older than the declaration carrier.
 */
const closedDeclarations: readonly ActionProposalDeclaration[] = [
  { modes: ['run'] },
  { ephemeral: true, modes: ['run'] },
  { ephemeral: true, modes: ['run', 'propose', 'approve'] },
];

const artifacts = (declaration?: ActionProposalDeclaration) =>
  renderActionHttpArtifacts({
    action: 'create-hold',
    declaration,
    errors: [],
    idempotency: 'required',
    payloadSchema: Schema.Struct({ amount: Schema.Number }),
    vertical: vertical(),
  });

/** The core-error mapping, where a 202 must never appear: Problem Details has no 202 status. */
const coreErrorMapping = (source: string): string => {
  const start = source.indexOf('const mapCoreProblem');
  return start === -1 ? '' : source.slice(start, source.indexOf('Match.exhaustive', start));
};

it('derives the 202 transport fact from the registered declaration alone', () => {
  expect(isProposableActionDeclaration(proposableDeclaration)).toBe(true);
  for (const declaration of closedDeclarations) {
    expect(isProposableActionDeclaration(declaration)).toBe(false);
  }
});

it('answers a parked proposal with the shared 202 schema on the success channel', () => {
  const { contract, problems, proposalAccepted } = artifacts(proposableDeclaration);
  expect(proposalAccepted).toBe(true);
  expect(contract).toContain("import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';");
  // Client-shared contracts must not import the runner and its database/runtime dependency graph.
  expect(contract).not.toContain('@app/core-runtime/http/action-runner');
  // Re-exported, so the endpoint and its client share Core's wire shape instead of re-declaring it.
  expect(contract).toContain("export { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';");
  // HTTP statuses belong to separate success entries, not branches of one outer Schema.Union.
  // Try the tagged 202 first so a broad ordinary result cannot swallow it.
  expect(contract).toContain('success: [ActionProposalAcceptedSchema, CreateHoldResultSchema],');
  expect(contract).not.toContain('success: Schema.Union');
  // The signal is an outcome, never a failure and never a Problem Details body.
  expect(contract).not.toContain('catchTag');
  expect(coreErrorMapping(contract)).not.toContain('ActionProposalAccepted');
  expect(problems).not.toContain('ActionProposalAccepted');
});

it('keeps the single result success type for an Action that cannot park a proposal', () => {
  for (const declaration of closedDeclarations) {
    const { contract, proposalAccepted, server } = artifacts(declaration);
    // No approved proposal can exist for this Action, so nothing about 202 enters its contract.
    expect(proposalAccepted).toBe(false);
    expect(contract).not.toContain('ActionProposalAccepted');
    expect(contract).toContain('success: CreateHoldResultSchema,');
    expect(server).not.toContain('successContract');
  }
  const undeclared = artifacts();
  expect(undeclared.proposalAccepted).toBe(false);
  expect(undeclared.contract).not.toContain('ActionProposalAccepted');
  expect(undeclared.server).not.toContain('successContract');
});

it('declares the 202 success contract on the handler that can answer it, and nowhere else', () => {
  // The contract and the handler read one declaration, so a regenerated endpoint cannot claim a 202
  // its `success` schema does not carry, nor leave a parked proposal unanswerable.
  expect(artifacts(proposableDeclaration).server).toContain("    successContract: 'result-or-proposal',\n");
  expect(artifacts({ modes: ['run'] }).server).not.toContain('ActionProposalAccepted');
});

it('offers the proposal intent only from a generated client whose declaration can park one', () => {
  const { client } = artifacts(proposableDeclaration);
  // An explicit, optional transport option: the client states the intent it is asked for and nothing else.
  expect(client).toContain("  readonly intent?: 'propose';");
  expect(client).toContain('intent: options.intent,');
  // Never proposed on the caller's behalf: no hard-coded intent, no denial-to-proposal retry, and no
  // 202 body in the client's own imports.
  expect(client).not.toContain("intent: 'propose'");
  expect(client).not.toContain('ActionProposalAccepted');
  expect(client).not.toContain('catchTag');
  expect(client).not.toContain('retry');
  // The governed shared runtime stays the single transport seam; the client never writes the header.
  expect(client).toContain('makeGovernedEffectBffClient(');
  expect(client).not.toContain('x-action-intent');
});

it('does not advertise a proposal intent from a run-only, ephemeral or undeclared client', () => {
  for (const declaration of closedDeclarations) {
    const { client } = artifacts(declaration);
    expect(client).not.toContain('intent');
    expect(client).not.toContain('ActionProposalAccepted');
  }
  const { client } = artifacts();
  expect(client).not.toContain('intent');
  // The ordinary governed transport (credential, correlation, idempotency) is unchanged.
  expect(client).toContain('makeGovernedEffectBffClient({ api: CreateHoldActionApi,');
  expect(client).toContain('idempotencyKey: options.idempotencyKey,');
  expect(client).toContain('requestCorrelation }, options);');
});
