import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getVerticalRuntimeActions } from '@app/core-runtime';
import { describe, expect, it } from 'effect-rstest';

import { catalogPublicOperationContracts } from '../../shared/api.ts';
import { catalogManifest } from '../../vertical.manifest.ts';
import { catalogRegistration } from '../../vertical.registration.ts';

const catalogRoot = fileURLToPath(new URL('../../', import.meta.url));
const source = (path: string) => readFileSync(new URL(path, `file://${catalogRoot}/`), 'utf-8');

/** The private capture/recovery closures are not exported; inspect only their identity-bearing calls. */
const identityAt = (text: string, functionName: string) => {
  const start = text.indexOf(`${functionName}(`);
  expect(start, `${functionName} must be wired`).toBeGreaterThanOrEqual(0);
  const tail = text.slice(start);
  const match =
    /actionInvocationId(?:\s*:\s*invocationId)?,\s*actionKey(?:\s*:\s*(?<key>[^,}]+))?,\s*schemaVersion:\s*(?<version>\d+)/u.exec(
      tail,
    );
  expect(match, `${functionName} must use an explicit snapshot identity`).not.toBeNull();
  return {
    actionKeyExpression: match?.groups?.key?.trim() ?? 'actionKey',
    schemaVersion: Number(match?.groups?.version),
  };
};

describe('all published Catalog Action snapshot/recovery tuples', () => {
  it('covers exactly the published registry and manifest inventory', () => {
    const manifestKeys = catalogManifest.publicSurface.actions.map((action) => action.descriptor.actionKey);
    const runtimeKeys = getVerticalRuntimeActions(catalogRegistration).map((action) => action.descriptor.actionKey);
    expect(manifestKeys).toHaveLength(82);
    expect(new Set(manifestKeys).size).toBe(82);
    expect(new Set(runtimeKeys)).toEqual(new Set(manifestKeys));
  });

  for (const action of catalogManifest.publicSurface.actions) {
    const { actionKey, schemaVersion } = action.descriptor;
    const slug = actionKey.slice('commerce.catalog.'.length);

    it(`${actionKey} captures and recovers the same immutable result identity`, () => {
      expect(actionKey).toBe(`commerce.catalog.${slug}`);
      const publicContract = Object.entries(catalogPublicOperationContracts).find(([key]) => key === actionKey)?.[1];
      expect(publicContract).toMatchObject({
        permission: actionKey,
        permissionKind: 'action_execution',
        scope: 'tenant',
      });
      const recoveryContract = Object.entries(catalogPublicOperationContracts).find(
        ([key]) => key === `commerce.catalog.api.${slug}-recovery`,
      )?.[1];
      expect(recoveryContract).toMatchObject({
        permission: `commerce.catalog.read.${slug}-recovery`,
        scope: 'tenant',
      });
      const expectedSchemaVersion = Number(schemaVersion);
      expect(Number.isSafeInteger(expectedSchemaVersion)).toBe(true);
      expect(expectedSchemaVersion).toBeGreaterThan(0);

      const actionSource = source(`src/actions/${slug}.action.ts`);
      const recoverySource = source(`src/api/${slug}-recovery.read.ts`);
      const capture = identityAt(actionSource, 'captureCatalogActionResult');
      const recovery = recoverySource.includes('recoverCatalogActionResult(')
        ? identityAt(recoverySource, 'recoverCatalogActionResult')
        : undefined;

      // ACTION_KEY is the descriptor's key in generated and owner-adapted Actions.
      const resolveKey = (expression: string | undefined) => {
        if (expression?.startsWith("'") === true) {
          return expression.slice(1, -1);
        }
        const declaration = new RegExp(`const ${expression} = '(?<key>[^']+)'`, 'u').exec(actionSource);
        return declaration?.groups?.key;
      };
      expect(resolveKey(capture.actionKeyExpression)).toBe(actionKey);
      expect(capture.schemaVersion).toBe(expectedSchemaVersion);
      const declaredResultSchema = /resultSchema:\s*(?<schema>[A-Za-z][A-Za-z0-9]*Schema)/u.exec(actionSource)?.groups
        ?.schema;
      expect(declaredResultSchema).toBeDefined();
      expect(actionSource).toContain(declaredResultSchema);
      if (recovery) {
        expect(recovery).toEqual({ actionKeyExpression: `'${actionKey}'`, schemaVersion: expectedSchemaVersion });
      } else {
        expect(recoverySource).toContain('recover');
      }
      expect(actionSource).toContain('captureCatalogActionResult(');
      if (recovery) {
        expect(recoverySource).toContain('Schema.decodeUnknownEffect(');
        expect(recoverySource).toContain('Schema.encodeEffect(');
      }
    });
  }
});
