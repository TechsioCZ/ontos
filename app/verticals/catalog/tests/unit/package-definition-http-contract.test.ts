import { describe, expect, it } from 'effect-rstest';

import { catalogAuthorityBundles, catalogPublicOperationContracts } from '../../shared/api.ts';
import { CreatePackageDefinitionActionApi } from '../../shared/apis/create-package-definition-action.ts';
import { RevisePackageDefinitionActionApi } from '../../shared/apis/revise-package-definition-action.ts';
import { RetirePackageDefinitionActionApi } from '../../shared/apis/retire-package-definition-action.ts';
import { PackageDefinitionActionError } from '../../shared/actions/package-definition-contract.ts';
import { mapCreatePackageDefinitionActionProblem } from '../../api/create-package-definition-action-problems.ts';
import { mapRevisePackageDefinitionActionProblem } from '../../api/revise-package-definition-action-problems.ts';
import { mapRetirePackageDefinitionActionProblem } from '../../api/retire-package-definition-action-problems.ts';
import {
  executeCreatePackageDefinition,
  executeRevisePackageDefinition,
  executeRetirePackageDefinition,
} from '@app/catalog/api/client';

const actions = [
  ['commerce.catalog.create-package-definition', CreatePackageDefinitionActionApi, executeCreatePackageDefinition],
  ['commerce.catalog.revise-package-definition', RevisePackageDefinitionActionApi, executeRevisePackageDefinition],
  ['commerce.catalog.retire-package-definition', RetirePackageDefinitionActionApi, executeRetirePackageDefinition],
] as const;
const mappers = [
  mapCreatePackageDefinitionActionProblem,
  mapRevisePackageDefinitionActionProblem,
  mapRetirePackageDefinitionActionProblem,
] as const;

describe('Package Definition HTTP Actions', () => {
  it('publishes three independent tenant-scoped Action transports and permissions', () => {
    for (const [key, api, client] of actions) {
      expect(api).toBeDefined();
      expect(client).toBeDefined();
      expect(catalogPublicOperationContracts[key]).toEqual({
        authorityBundle: 'CATALOG_DEFINITION_MANAGER',
        businessTarget: 'package-definition',
        permission: key,
        permissionKind: 'action_execution',
        scope: 'tenant',
        version: '1',
      });
      expect(catalogAuthorityBundles.CATALOG_DEFINITION_MANAGER).toContain(key);
    }
  });

  it('maps expected domain failures to redacted and distinct HTTP semantics', () => {
    for (const map of mappers) {
      for (const [code, status, retryable] of [
        ['package_definition_invalid', 422, undefined],
        ['package_definition_stale', 409, undefined],
        ['package_definition_unavailable', 503, true],
      ] as const) {
        const problem = map(
          new PackageDefinitionActionError({ code, reason: 'private persistence and identity detail' }),
        );
        expect(problem).toMatchObject({ code, status });
        if (retryable) {
          expect(problem).toMatchObject({ retryable: true });
        }
        expect(JSON.stringify(problem)).not.toContain('private persistence and identity detail');
      }
    }
  });
});
