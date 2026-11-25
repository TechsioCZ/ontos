import { fileURLToPath } from 'node:url';

import { NodeFileSystem, NodePath } from '@effect/platform-node';
import { CodeSmith, GeneratorCore } from '@modern-js/codesmith';
import { Effect, FileSystem, Schema } from 'effect';
import { afterEach, expect, it, rs } from 'effect-rstest';

import scaffoldAction from '../action/scaffold.mts';
import type { ActionScaffoldConfig } from '../shared.mts';

const actions = [
  { action: 'configure-agent', handler: 'handleConfigureAgent', legalEntityScope: 'required' },
  { action: 'invite-person', handler: 'handleInvitePerson', legalEntityScope: 'required' },
  { action: 'manage-agent-status', handler: 'handleManageAgentStatus', legalEntityScope: 'required' },
  { action: 'manage-demo-account', handler: 'handleManageDemoAccount', legalEntityScope: 'required' },
  { action: 'mutate-agent-proposals', handler: 'handleMutateAgentProposals', legalEntityScope: 'required' },
  { action: 'replace-agent-operators', handler: 'handleReplaceAgentOperators', legalEntityScope: 'required' },
  { action: 'set-company-membership', handler: 'handleSetCompanyMembership', legalEntityScope: 'required' },
] as const;

afterEach(() => {
  rs.restoreAllMocks();
});

it.live('inventories every native Core Action in the catalog, independent of generated markers', () =>
  Effect.gen(function* completeCoreActionCatalog() {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = fileURLToPath(new URL('../../../packages/core-runtime/src/modules/actions/', import.meta.url));
    const files = (yield* fileSystem.readDirectory(directory, { recursive: true }))
      .filter((file) => file.endsWith('.action.ts'))
      .toSorted();
    const catalog = yield* fileSystem.readFileString(`${directory}/catalog.ts`);
    const registrations: string[] = [];
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = yield* fileSystem.readFileString(`${directory}/${file}`);
      const exports = [...source.matchAll(/^export const (?<registration>[a-zA-Z0-9]+Action) = defineAction\(/gmu)];
      expect(exports, `${file} must declare its native Action`).toHaveLength(1);
      const registration = exports[0]?.groups?.['registration'];
      if (registration === undefined) {
        throw new Error(`${file} has no native Action registration`);
      }
      registrations.push(registration);
      expect(catalog).toContain(`import { ${registration} } from './${file}';`);
    }
    const catalogImports = [...catalog.matchAll(/^import \{ \w+Action \} from '\.\/(?<file>[^']+\.action\.ts)';$/gmu)];
    expect(
      catalogImports.map((match) => Schema.decodeUnknownSync(Schema.String)(match.groups?.['file'])).toSorted(),
    ).toEqual(files);
    const catalogValues = [...catalog.matchAll(/^\s+(?<registration>\w+Action)\.descriptor,$/gmu)];
    expect(
      catalogValues.map((match) => Schema.decodeUnknownSync(Schema.String)(match.groups?.['registration'])).toSorted(),
    ).toEqual(registrations.toSorted());
  }).pipe(Effect.provide(NodeFileSystem.layer)),
);

for (const { action, handler, legalEntityScope } of actions) {
  it.live(`maintains ${action} on the actual native Codesmith scaffold without a disk fixture`, () =>
    Effect.gen(function* nativeIdentityScaffoldContract() {
      const root = '/in-memory/identity-actions';
      const indexPath = `${root}/packages/core-runtime/src/index.ts`;
      const catalogPath = `${root}/packages/core-runtime/src/modules/actions/catalog.ts`;
      const files = new Map([
        [indexPath, '// <generated-core-action-exports>\n// </generated-core-action-exports>\n'],
        [
          catalogPath,
          [
            '// <generated-core-action-catalog-imports>',
            '// </generated-core-action-catalog-imports>',
            'export const catalog = [',
            '// <generated-core-action-catalog-values>',
            '// </generated-core-action-catalog-values>',
            '];',
            '',
          ].join('\n'),
        ],
      ]);
      const fileSystem = FileSystem.makeNoop({
        exists: (path) => Effect.succeed(files.has(path)),
        readFileString: (path) => {
          const source = files.get(path);
          return source === undefined
            ? Effect.die(`Unexpected in-memory scaffold read: ${path}`)
            : Effect.succeed(source);
        },
      });
      const smith = new CodeSmith({ namespace: 'identity-action-scaffold-contract' });
      const core = new GeneratorCore({
        logger: smith.logger,
        materialsManager: smith.materialsManager,
        outputPath: root,
      });
      const output = rs.spyOn(core.output, 'fs').mockImplementation(async (relativePath, content) => {
        files.set(`${root}/${relativePath}`, Schema.decodeUnknownSync(Schema.String)(content));
      });
      const config: ActionScaffoldConfig = {
        action,
        authorization: 'protected',
        legalEntityScope,
        module: 'core.identity',
        scope: 'core',
      };
      const result = yield* scaffoldAction({ ...core._context, config }, core).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provide(NodePath.layer),
      );
      expect(result.actionPath).toBe(`${root}/packages/core-runtime/src/modules/actions/${action}.action.ts`);
      expect(output).toHaveBeenCalledTimes(3);
      expect([...files.keys()].toSorted()).toEqual([indexPath, catalogPath, result.actionPath].toSorted());
      const generated = files.get(result.actionPath);
      if (generated === undefined) {
        throw new Error('The actual Codesmith Action output was not captured');
      }
      const maintainedPath = fileURLToPath(
        new URL(`../../../packages/core-runtime/src/modules/actions/${action}.action.ts`, import.meta.url),
      );
      const maintained = yield* FileSystem.FileSystem.use((liveFileSystem) =>
        liveFileSystem.readFileString(maintainedPath),
      ).pipe(Effect.provide(NodeFileSystem.layer));
      expect(maintained.startsWith(`${generated.split('\n').slice(0, 3).join('\n')}\n`)).toBe(true);
      expect(generated).toContain(`const ${handler} = () =>`);
      expect(maintained).toContain(`const ${handler} = Effect.fn(`);
      expect(generated).toContain(`\n  ${handler},\n`);
      expect(maintained).toContain(`\n  ${handler},\n`);
      for (const literal of [
        `policyKey: 'core.identity.${action}.access.v1'`,
        `actionKey: 'core.identity.${action}'`,
        `entrypointKey: 'core.identity.${action}'`,
        "moduleKey: 'core.identity'",
        "owningModuleKey: 'core.identity'",
        "authorization: { kind: 'protected' }",
        "idempotency: 'required'",
        `legalEntityScope: '${legalEntityScope}'`,
        "schemaVersion: '1'",
      ]) {
        expect(generated).toContain(literal);
        expect(maintained).toContain(literal);
      }
      expect(maintained).toContain('entrypoint: defineSystemModuleEntrypoint({');
      expect(maintained).toContain("auditProfile: 'sensitive'");
      expect(maintained).not.toContain('action_not_implemented');
      expect(maintained).not.toContain('NotImplemented');
    }),
  );
}
