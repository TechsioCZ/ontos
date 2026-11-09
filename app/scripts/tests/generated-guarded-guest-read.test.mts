import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'effect-rstest';
import { parseSync } from 'oxc-parser';

import { hasCompleteGeneratedModuleRead } from '../generated-governed-http-boundary.mts';

// The Party Registry guest-evidence read starts its load from its own typed services projection and builds
// that projection from the owner's native Effect.fn resolver. These tests pin the real source and the
// tampering shapes that must stay rejected: flipped or dropped tenant/legal-entity/evidence guards, a
// foreign scope or receiver, an undeclared or non-native service method, a rewritten or side-effecting
// factory, a dropped early NotFound, and a replaced evidence/result projection.
const root = path.resolve(import.meta.dirname, '../..');
const excluded = new Set(['.git', '.modern', '.output', 'coverage', 'dist', 'node_modules']);
const sources = new Map<string, string>();
const collect = (directory: string): void => {
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory() && !excluded.has(entry.name)) {
      collect(file);
    } else if (entry.isFile() && /\.(?:ts|mts|json)$/u.test(file)) {
      sources.set(file, readFileSync(path.join(root, file), 'utf-8'));
    }
  }
};
collect('verticals');

const owner = 'verticals/party-registry';
const readFile = `${owner}/src/api/guest-party-resolution.read.ts`;
const serviceFile = `${owner}/src/services/guest-party-resolution.service.ts`;
const loadProof = 'guarded guest service read load';
const notFoundReason = "reason: 'The requested guest evidence does not exist in the trusted scope',";
const resolveCall = 'resolveGuestPartyEvidence(transaction, input)';
const resolveMember = `resolve: (input: Parameters<typeof resolveGuestPartyEvidence>[1]) =>
        ${resolveCall},`;

const accepts = (changed: ReadonlyMap<string, string>, diagnostics?: string[]): boolean =>
  hasCompleteGeneratedModuleRead(changed, readFile, owner, 'party.registry', 'guest-party-resolution', diagnostics);

const changed = (file: string, before: string, after: string): ReadonlyMap<string, string> => {
  const source = sources.get(file);
  expect(source, file).toBeDefined();
  const mutated = (source ?? '').replace(before, after);
  expect(mutated, `${file}: ${before}`).not.toBe(source);
  expect(parseSync(file, mutated).errors).toEqual([]);
  return new Map([...sources, [file, mutated]]);
};

it('proves the real guarded guest-evidence native service read', () => {
  const diagnostics: string[] = [];
  expect(accepts(sources, diagnostics), `${readFile}\n${diagnostics.join('\n')}`).toBe(true);
});

// `scopedProof` marks the tampering shapes the guarded load proof itself must reject; the others still have
// to be rejected, but a foreign `Effect` module makes the phase unreachable before that proof runs.
for (const [name, file, before, after, scopedProof] of [
  // The tenant, legal-entity, and untrimmed evidence checks are the read's whole guard.
  [
    'flipped tenant guard',
    readFile,
    'input.legalEntityRef.tenantId !== context.scope.tenantId',
    'input.legalEntityRef.tenantId === context.scope.tenantId',
    true,
  ],
  [
    'inverted legal-entity presence guard',
    readFile,
    'context.scope.legalEntityId === undefined',
    'context.scope.legalEntityId !== undefined',
    true,
  ],
  [
    'flipped legal-entity guard',
    readFile,
    'input.legalEntityRef.resourceId !== context.scope.legalEntityId',
    'input.legalEntityRef.resourceId === context.scope.legalEntityId',
    true,
  ],
  [
    'dropped untrimmed evidence guard',
    readFile,
    'input.guestEvidenceRef !== input.guestEvidenceRef.trim()',
    'input.guestEvidenceRef !== undefined',
    true,
  ],
  [
    'dropped untrimmed correlation guard',
    readFile,
    'input.correlationRoot !== input.correlationRoot.trim()',
    'input.correlationRoot !== undefined',
    true,
  ],
  [
    'guard never taken',
    readFile,
    'if (\n    input.legalEntityRef.tenantId',
    'if (\n    false || input.legalEntityRef.tenantId',
    true,
  ],
  // Only the read's own scope and services supply the guard and the call.
  [
    'foreign scope',
    readFile,
    'input.legalEntityRef.tenantId !== context.scope.tenantId',
    'input.legalEntityRef.tenantId !== foreignScope.tenantId',
    true,
  ],
  ['foreign services receiver', readFile, 'context.services.resolve(input)', 'foreign.services.resolve(input)', true],
  // The called method must be the one the read's own services contract declares.
  ['undeclared service method', readFile, 'context.services.resolve(input)', 'context.services.forged(input)', true],
  [
    'undeclared contract helper',
    readFile,
    'ReturnType<typeof resolveGuestPartyEvidence>;',
    'ReturnType<typeof foreignEvidence>;',
    true,
  ],
  [
    'extra contract member',
    readFile,
    'readonly resolve: (',
    'readonly extra: () => void;\n  readonly resolve: (',
    true,
  ],
  [
    'foreign load context',
    readFile,
    'context: ReadLoadContext<GuestPartyResolutionReadServices>,',
    'context: ForeignLoadContext<GuestPartyResolutionReadServices>,',
    true,
  ],
  // Every stage must stay a native Effect combinator with the original mapper.
  ['foreign error transform', readFile, 'Effect.mapError(unavailable)', 'ForeignEffect.mapError(unavailable)', true],
  ['foreign error mapper', readFile, 'Effect.mapError(unavailable)', 'Effect.mapError(foreignUnavailable)', true],
  [
    'foreign Effect module',
    readFile,
    "import { Effect } from 'effect';",
    "import { Effect } from './foreign-effect.ts';",
    false,
  ],
  // The early NotFound branch keeps its own error class, code, and static reason.
  ['not-found error class', readFile, 'new ReadHandlerNotFound({', 'new ReadHandlerUnavailable({', true],
  ['not-found error code', readFile, "code: 'read_handler_not_found',", "code: 'read_handler_unavailable',", true],
  ['non-static not-found reason', readFile, notFoundReason, 'reason: foreignReason,', true],
  // The evidence/result projection may not drop or replace the resolved owner result.
  [
    'replaced result count',
    readFile,
    'evidence: { resultCount: 1 },',
    'evidence: { resultCount: untrustedCount },',
    true,
  ],
  [
    'dropped owner result',
    readFile,
    'evidence: { resultCount: 1 },\n      result,\n    })),',
    'evidence: { resultCount: 1 },\n    })),',
    true,
  ],
  // The scoped factory must forward its own transaction to the declared owner helper, unchanged.
  ['foreign factory helper', readFile, resolveCall, 'foreignResolver(transaction, input)', true],
  ['swapped factory arguments', readFile, resolveCall, 'resolveGuestPartyEvidence(input, transaction)', true],
  [
    'side-effecting factory',
    readFile,
    resolveMember,
    `resolve: (input: Parameters<typeof resolveGuestPartyEvidence>[1]) => {
        touched = transaction;
        return ${resolveCall};
      },`,
    true,
  ],
  // The owner helper must stay a native Effect.fn from the owner's own service module.
  [
    'non-native owner helper',
    serviceFile,
    "export const resolveGuestPartyEvidence = Effect.fn('GuestPartyResolutionService.resolveGuestPartyEvidence')(",
    "export const resolveGuestPartyEvidence = foreignEffectFn('GuestPartyResolutionService.resolveGuestPartyEvidence')(",
    true,
  ],
] as const) {
  it(`rejects the guarded guest-evidence read with a ${name}`, () => {
    const diagnostics: string[] = [];
    expect(accepts(changed(file, before, after), diagnostics), name).toBe(false);
    expect(
      diagnostics.some((diagnostic) => diagnostic.startsWith(loadProof)),
      `${name}\n${diagnostics.join('\n')}`,
    ).toBe(scopedProof);
  });
}

for (const [name, file, tail] of [
  ['shadowed Effect binding', readFile, '\nfunction shadow(Effect: unknown) {}'],
  ['reassigned owner helper', readFile, '\nresolveGuestPartyEvidence = fake;'],
  ['destructured owner helper', readFile, '\n({ resolveGuestPartyEvidence } = attacker);'],
] as const) {
  it(`rejects the guarded guest-evidence read with a ${name}`, () => {
    const source = sources.get(file) ?? '';
    const mutated = `${source}\n${tail}`;
    expect(mutated, `${file}: ${tail}`).not.toBe(source);
    expect(parseSync(file, mutated).errors).toEqual([]);
    const diagnostics: string[] = [];
    expect(accepts(new Map([...sources, [file, mutated]]), diagnostics), name).toBe(false);
    expect(
      diagnostics.some((diagnostic) => diagnostic.startsWith(loadProof)),
      `${name}\n${diagnostics.join('\n')}`,
    ).toBe(true);
  });
}
