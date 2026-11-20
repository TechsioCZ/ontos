import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Path, Schema, SchemaAST } from 'effect';
import { expect, it } from 'effect-rstest';

import { assetCurrentRead } from '../../src/generated-reads/asset-current.ts';
import { AssetCurrentRequestSchema, AssetCurrentResponseSchema } from '../../src/media/current-contract.ts';
import { coreActionCatalog } from '../../src/index.ts';

/*
 * Static guards of Current V1 (#1443, ADR-0031). They read the shipped sources as text on purpose: an absent
 * concept leaves nothing else to assert on, and the claim to prove is exactly that nothing of the kind appeared. They
 * fail when the scope #1444 rejected is built: a version store, a Current pointer or switch, a V2, a publication
 * Action, a Media Link written by the read, an automatic Catalog assignment, a revision taken from the provider, or a
 * storage value in the answer. Behavior (one answer per ref, revision 1 only for a stat-confirmed asset) is proven in
 * the unit and the integration suites.
 */

const readRelative = Effect.fn('CoreMediaCurrentGuards.read')(function* readRelative(relative: string) {
  const [fileSystem, path] = yield* Effect.all([FileSystem.FileSystem, Path.Path], { concurrency: 2 });
  return yield* fileSystem.readFileString(yield* path.fromFileUrl(new URL(`../../${relative}`, import.meta.url)));
});

/** Comments describe what is excluded; only code can contain a forbidden concept. */
const codeOf = (text: string): string =>
  text
    .replaceAll(/\/\*[\s\S]*?\*\//gu, '')
    .replaceAll(/^\s*\/\/.*$/gmu, '')
    .replaceAll(/\s\/\/.*$/gmu, '');

const fieldNamesOf = (ast: SchemaAST.AST): readonly string[] => {
  if (SchemaAST.isObjects(ast)) {
    return ast.propertySignatures.flatMap(({ name, type }) => [String(name), ...fieldNamesOf(type)]);
  }
  if (SchemaAST.isUnion(ast)) {
    return ast.types.flatMap(fieldNamesOf);
  }
  if (SchemaAST.isArrays(ast)) {
    return [...ast.elements, ...ast.rest].flatMap(fieldNamesOf);
  }
  return [];
};

const CURRENT_SOURCES = ['src/generated-reads/asset-current.ts', 'src/media/current-contract.ts'] as const;

it.layer(NodeServices.layer, { excludeTestServices: true })(
  'core media Current V1 builds none of the rejected scope',
  (suite) => {
    suite.effect('has no version store, Current pointer, switch, V2, publication or link write in its code', () =>
      Effect.gen(function* noRejectedScope() {
        for (const file of CURRENT_SOURCES) {
          const code = codeOf(yield* readRelative(file));
          expect(code, `${file} must not mention a version store or document`).not.toMatch(
            /documentVersion|document_version|DocumentVersion|\bdocument\b/iu,
          );
          expect(code, `${file} must not hold a Current pointer or switch`).not.toMatch(
            /currentPointer|current_pointer|(?:^|[^a-zA-Z])(?:setCurrent|switchCurrent)|publishVersion|promote|supersede/u,
          );
          expect(code, `${file} must not mention another version`).not.toMatch(
            /\bv2\b|revision\s*[:=]\s*(?:[02-9]|\d{2})/iu,
          );
          expect(code, `${file} must not write or read a link, a table or a row`).not.toMatch(
            /mediaLinks|media_links|\.insert\(|\.update\(|\.delete\(|\.execute\(/u,
          );
          expect(code, `${file} must not assign to Catalog`).not.toMatch(/assign|catalog/iu);
          // A provider version reference is a technical pin, never a revision or an identity of the answer.
          expect(code, `${file} must not read the provider version`).not.toMatch(/storageObjectVersionRef|versionRef/u);
        }
      }),
    );

    suite.effect('derives the revision from one constant and reads nothing but the row and a provider stat', () =>
      Effect.gen(function* oneConstant() {
        const contract = codeOf(yield* readRelative('src/media/current-contract.ts'));
        expect(contract.match(/revision\s*[:=]/gu)?.length).toBeLessThanOrEqual(2);
        expect(contract).toContain('MEDIA_CURRENT_REVISION = 1');
        const read = codeOf(yield* readRelative('src/generated-reads/asset-current.ts'));
        // The only provider call is the stat check: no byte is read, no digest computed, nothing is recorded.
        expect(read).toContain('statReadyMediaAsset');
        expect(read).not.toMatch(
          /openVerifiedMediaStream|verifyReadyMediaAsset|\.get\(|\.put\(|ContentDigest|integrity/iu,
        );
      }),
    );

    it('carries only owner-qualified refs, states and the constant revision, and no storage value or revisionId', () => {
      const names = [...fieldNamesOf(AssetCurrentRequestSchema.ast), ...fieldNamesOf(AssetCurrentResponseSchema.ast)];
      expect(new Set(names)).toEqual(
        new Set([
          'mediaAssetRefs',
          'entries',
          'kind',
          'resourceRef',
          'current',
          'revision',
          'moduleId',
          'resourceId',
          'resourceType',
          'tenantId',
        ]),
      );
      expect(Schema.is(AssetCurrentResponseSchema)({ entries: [] })).toBe(true);
    });

    it('adds no Action beyond the audited four, so there is no publication or Current-switch Action', () => {
      expect(
        coreActionCatalog
          .filter(({ owningModuleKey }) => owningModuleKey === 'core.media')
          .map(({ actionKey }) => actionKey)
          .toSorted(),
      ).toEqual([
        'core.media.confirm-asset',
        'core.media.record-asset-integrity-failure',
        'core.media.rename-display-filename',
        'core.media.upload-asset',
      ]);
    });

    it('is one tenant-wide read with no record target and no write mode', () => {
      expect(assetCurrentRead.descriptor.accessTarget).toBeUndefined();
      expect(assetCurrentRead.descriptor.accessDeclaration).toMatchObject({
        kind: 'read',
        modes: ['run'],
        selectors: [],
      });
    });
  },
);
