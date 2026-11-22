import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Path } from 'effect';
import { expect, it } from 'effect-rstest';

/*
 * The Catalog side of the Core Media boundary (#1443, ADR-0031, ratified Q-D): the hard-wired `unavailableOwner` is
 * gone from production wiring, and Catalog reaches Core Media only through the published `@app/core-runtime/sdk/core`
 * operation reference. It holds no provider credential, no object-store port and no Core Media private path or table,
 * and the existing Catalog contract files (assignment, availability and the public response) are untouched.
 */

const readApp = Effect.fn('CatalogCoreMediaBoundary.read')(function* readApp(relative: string) {
  const [fileSystem, path] = yield* Effect.all([FileSystem.FileSystem, Path.Path], { concurrency: 2 });
  return yield* fileSystem.readFileString(yield* path.fromFileUrl(new URL(`../../${relative}`, import.meta.url)));
});

/** Comments describe what is excluded; only code can contain a forbidden concept. */
const codeOf = (text: string): string =>
  text
    .replaceAll(/\/\*[\s\S]*?\*\//gu, '')
    .replaceAll(/^\s*\/\/.*$/gmu, '')
    .replaceAll(/\s\/\/.*$/gmu, '');

const BOUNDARY_SOURCES = [
  'src/api/catalog-document-current.read.ts',
  'src/integrations/core-media-owner.ts',
  'vertical.runtime-declaration.ts',
] as const;

it.layer(NodeServices.layer, { excludeTestServices: true })('the Catalog Core Media binding', (suite) => {
  suite.effect('has no hard-wired unavailable owner left in the production read', () =>
    Effect.gen(function* noUnavailableOwner() {
      const read = codeOf(yield* readApp('src/api/catalog-document-current.read.ts'));
      expect(read).not.toContain('unavailableOwner');
      expect(read).not.toContain('DocumentsCenterCurrentUnavailable');
      // The one owner call is the declared Core operation, made with no transaction open (the three-step run).
      expect(read).toContain('declaredCall(coreOperations.assetCurrent');
      expect(read).toContain('context.call');
    }),
  );

  suite.effect(
    'reaches Core Media only through the published operation: no private path, port, table or credential',
    () =>
      Effect.gen(function* publishedContractOnly() {
        for (const file of BOUNDARY_SOURCES) {
          const code = codeOf(yield* readApp(file));
          expect(code, file).not.toMatch(/@app\/core-runtime\/(?:media|generated-reads)|core-runtime\/src/u);
          expect(code, file).not.toMatch(
            /ObjectStorage|S3|CORE_MEDIA_S3|storageObjectVersionRef|media_assets|media_links/u,
          );
          if (file !== 'vertical.runtime-declaration.ts') {
            expect(code, file).not.toMatch(/Bearer|apiKey|credentials?\b|secret/iu);
          }
        }
      }),
  );

  suite.effect('declares the requirement as the requester relayed, the only caller Core Media accepts', () =>
    Effect.gen(function* requesterOnly() {
      const declaration = codeOf(yield* readApp('vertical.runtime-declaration.ts'));
      const start = declaration.indexOf("key: 'commerce.catalog.requirement.core-media-current'");
      expect(start).toBeGreaterThan(0);
      const block = declaration.slice(Math.max(0, start - 400), start + 300);
      expect(block).toContain("callers: [{ kind: 'person', legalEntityScope: 'subject' }]");
      expect(block).not.toMatch(/registered|workload/u);
    }),
  );

  suite.effect(
    'relays the requester under their selected company: the read accepts a company and the requirement carries it',
    () =>
      Effect.gen(function* companyNarrowedRelay() {
        // The platform refuses a company on a `forbidden` read (OperationContextInvalid), so a `forbidden` read could
        // never hold the company a `subject` relay carries; and a `tenant` relay strips the company the read has, so
        // Core's own narrowing (a selected company sees its own and company-less assets only) never applies and every
        // holder of Current learns the availability of a company-owned asset behind a ref Catalog holds. Both halves
        // are therefore one change: the read is `optional` and the requirement relays the `subject`. Change both or
        // neither (handoff decision 7, CORE_MEDIA.md).
        const read = codeOf(yield* readApp('src/api/catalog-document-current.read.ts'));
        expect(read).toContain("legalEntityScope: 'optional'");
        expect(read).not.toContain("legalEntityScope: 'forbidden'");
        const declaration = codeOf(yield* readApp('vertical.runtime-declaration.ts'));
        expect(declaration).toContain("callers: [{ kind: 'person', legalEntityScope: 'subject' }]");
        const start = declaration.indexOf("key: 'commerce.catalog.requirement.core-media-current'");
        expect(declaration.slice(Math.max(0, start - 400), start)).not.toContain("legalEntityScope: 'tenant'");
      }),
  );

  suite.effect('leaves the Catalog contract files exactly as they were: the guard is their content, not the diff', () =>
    Effect.gen(function* contractUnchanged() {
      const domain = yield* readApp('shared/domain/catalog-media-assignment.ts');
      // The five owner states and the revision-carrying AVAILABLE are the contract; nothing was added or renamed.
      expect(domain).toContain("readonly kind: 'ABSENT' | 'CURRENT_UNVERIFIED' | 'FORBIDDEN' | 'UNAVAILABLE';");
      expect(domain).toContain('readonly current: CatalogDocumentOwnerRevision;');
      expect(domain).toContain('revisionId: Schema.optionalKey(CatalogRevisionIdSchema)');
      const api = yield* readApp('shared/apis/catalog-document-current.ts');
      expect(api).toContain(
        "Schema.Literals(['ABSENT', 'CURRENT_UNVERIFIED', 'FORBIDDEN', 'RESOURCE_MISMATCH', 'UNAVAILABLE'])",
      );
    }),
  );
});
