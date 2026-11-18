import { readFileSync } from 'node:fs';
import { expect, it } from 'effect-rstest';

import { validRuntimeDeclarationViews } from '../shared.mts';

const readOwner = (path: string) => readFileSync(new URL(`../../../verticals/${path}`, import.meta.url), 'utf-8');
const backend = readOwner('party-registry/vertical.runtime-declaration.ts');
const manifest = readOwner('party-registry/vertical.manifest.ts');
const registration = readOwner('party-registry/vertical.registration.ts');
const fullSurfaceSpread = '...partyRegistryRuntimeManifest.publicSurface,';
const mcpProperty = 'mcp: partyRegistryMcpContribution,';
const validateParty = (backendSource = backend, manifestSource = manifest, registrationSource = registration) =>
  validRuntimeDeclarationViews(backendSource, manifestSource, registrationSource, 'partyRegistry', 'party.registry');
const manifestWithMcp = manifest.replace(fullSurfaceSpread, `${fullSurfaceSpread}\n    ${mcpProperty}`);

it('accepts the full Party manifest with and without an MCP contribution', () => {
  expect(manifestWithMcp).not.toBe(manifest);
  expect(validateParty()).toBe(true);
  expect(validateParty(backend, manifestWithMcp)).toBe(true);
});

it('does not permit MCP on the backend-only view or unknown/duplicate/computed full-surface keys', () => {
  const withBackendMcp = backend.replace('publicSurface: {', 'publicSurface: { mcp: partyRegistryMcpContribution,');
  expect(withBackendMcp).not.toBe(backend);
  expect(() => validateParty(withBackendMcp)).toThrow(/shared declaration provenance/u);
  for (const invalid of [
    manifestWithMcp.replace(fullSurfaceSpread, `${fullSurfaceSpread}\n  unrelated: [],`),
    manifestWithMcp.replace(mcpProperty, `${mcpProperty}\n  ${mcpProperty}`),
    manifestWithMcp.replace(mcpProperty, '[mcp]: partyRegistryMcpContribution,'),
  ]) {
    expect(invalid).not.toBe(manifestWithMcp);
    expect(() => validateParty(backend, invalid)).toThrow(/shared declaration provenance/u);
  }
});
