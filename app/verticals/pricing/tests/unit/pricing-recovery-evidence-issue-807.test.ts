import { fileURLToPath } from 'node:url';

import { NodeFileSystem } from '@effect/platform-node';
import { Effect, FileSystem } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type { Issue807RecoveryEvidenceEntry } from './support/issue-807-recovery-evidence.ts';

import {
  ISSUE_807_EVIDENCE_OWNER_ISSUES,
  ISSUE_807_KNOWN_GAP_IDS,
  ISSUE_807_RECOVERY_EVIDENCE,
  ISSUE_807_REQUIRED_OBLIGATION_IDS,
} from './support/issue-807-recovery-evidence.ts';

const appRoot = new URL('../../../../', import.meta.url);

const assertReference = (
  fileSystem: FileSystem.FileSystem,
  reference: { readonly path: string; readonly symbol: string },
  kind: 'production' | 'test',
) =>
  Effect.gen(function* validateEvidenceReference() {
    const file = new URL(reference.path, appRoot);
    expect(yield* fileSystem.exists(fileURLToPath(file)), `${kind} evidence path must exist: ${reference.path}`).toBe(
      true,
    );
    const source = yield* fileSystem.readFileString(fileURLToPath(file));
    expect(source, `${kind} evidence symbol must exist: ${reference.path}#${reference.symbol}`).toContain(
      reference.symbol,
    );
    if (kind === 'test') {
      expect(reference.path.endsWith('.test.ts')).toBe(true);
    } else {
      expect(reference.path.includes('/tests/')).toBe(false);
    }
  });

describe('issue #807 machine-checkable recovery evidence', () => {
  it('covers every declared obligation exactly once with valid owner issues', () => {
    const ids = ISSUE_807_RECOVERY_EVIDENCE.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.toSorted((left, right) => left.localeCompare(right))).toEqual(
      [...ISSUE_807_REQUIRED_OBLIGATION_IDS].toSorted((left, right) => left.localeCompare(right)),
    );

    const allowedIssues = new Set<number>(ISSUE_807_EVIDENCE_OWNER_ISSUES);
    const referencedIssues = new Set<number>();
    for (const entry of ISSUE_807_RECOVERY_EVIDENCE) {
      expect(entry.ownerIssues.length).toBeGreaterThan(0);
      for (const issue of entry.ownerIssues) {
        expect(allowedIssues.has(issue), `${entry.id} has invalid owner issue #${issue}`).toBe(true);
        referencedIssues.add(issue);
      }
    }
    expect([...referencedIssues].toSorted((left, right) => left - right)).toEqual(
      [...allowedIssues].toSorted((left, right) => left - right),
    );
  });

  it.layer(NodeFileSystem.layer)('repository file evidence', (suite) => {
    suite.effect('resolves every production symbol and executable-test reference', () =>
      Effect.gen(function* resolveEvidenceReferences() {
        const fileSystem = yield* FileSystem.FileSystem;
        for (const entry of ISSUE_807_RECOVERY_EVIDENCE) {
          expect(entry.production.length, `${entry.id} needs production evidence`).toBeGreaterThan(0);
          expect(entry.tests.length, `${entry.id} needs executable test evidence`).toBeGreaterThan(0);
          for (const reference of entry.production) {
            yield* assertReference(fileSystem, reference, 'production');
          }
          for (const reference of entry.tests) {
            yield* assertReference(fileSystem, reference, 'test');
          }
        }
      }),
    );
  });

  it('never hides a partial or missing proof behind a green claim', () => {
    const expectedKnownGapIds: readonly string[] = ISSUE_807_KNOWN_GAP_IDS;
    const knownGapIds = new Set<string>(expectedKnownGapIds);
    const evidenceEntries: readonly Issue807RecoveryEvidenceEntry[] = ISSUE_807_RECOVERY_EVIDENCE;
    for (const entry of evidenceEntries) {
      if (entry.status === 'PROVEN') {
        expect(entry.gap, `${entry.id} cannot be proven while describing a gap`).toBeNull();
        expect(entry.missingEvidence).toEqual([]);
      } else {
        expect(entry.gap?.trim().length ?? 0, `${entry.id} has a silent gap`).toBeGreaterThan(0);
        expect(entry.missingEvidence.length, `${entry.id} must name missing evidence`).toBeGreaterThan(0);
      }
      if (knownGapIds.has(entry.id)) {
        expect(entry.status, `${entry.id} is an unresolved #807 gap`).not.toBe('PROVEN');
      }
    }
    expect(
      ISSUE_807_RECOVERY_EVIDENCE.filter(({ status }) => status !== 'PROVEN')
        .map(({ id }) => id)
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual([...expectedKnownGapIds].toSorted((left, right) => left.localeCompare(right)));
  });
});
