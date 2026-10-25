import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  bootstrapRelationshipRequest,
  scopedActionRoleBootstrapRelationships,
} from '../../packages/core-runtime/src/install/context-bootstrap-shared.ts';
import { coreActionCatalog } from '../../packages/core-runtime/src/modules/actions/catalog.ts';
import { demoLegalEntityId, demoTenantId } from './fixture-ids.mts';
import { demoHumanAccounts, scopedDemoActionRelationships } from './permissions.mts';

// The bootstrap consumer accepts an omitted userset, but not protobuf's empty-string sentinel.
const SubjectSchema = Schema.Struct({
  subjectRelation: Schema.optionalKey(Schema.Trim.check(Schema.isNonEmpty())),
});

it.effect('omits empty native subject relations without changing bootstrap authorization', () =>
  Effect.gen(function* validatesBootstrapSubjects() {
    const { principalId } = demoHumanAccounts[0];
    let directSubjects = 0;
    let usersets = 0;
    for (const descriptor of coreActionCatalog) {
      const action = {
        actionKey: descriptor.actionKey,
        legalEntityScope: descriptor.legalEntityScope,
        owningModuleKey: descriptor.owningModuleKey,
        provisioning: descriptor.entrypoint.authorization.provisioning,
      };
      const scope =
        action.legalEntityScope === 'forbidden'
          ? { tenantId: demoTenantId }
          : { legalEntityId: demoLegalEntityId, tenantId: demoTenantId };
      const roleKey = 'bootstrap-subject-regression';
      const native = scopedActionRoleBootstrapRelationships({ ...scope, action, roleKey });
      const relationships = scopedDemoActionRelationships(
        principalId,
        action,
        demoLegalEntityId,
        demoTenantId,
        roleKey,
      );
      // The demo adds its explicit role membership and, for tenant Actions, a context-role link.
      const projected = relationships.slice(action.legalEntityScope === 'forbidden' ? 2 : 1);
      yield* Schema.decodeUnknownEffect(Schema.Array(SubjectSchema))(relationships);
      expect(bootstrapRelationshipRequest(projected)).toEqual(bootstrapRelationshipRequest(native));
      for (const [index, row] of native.entries()) {
        if (row.subjectRelation === '') {
          directSubjects += 1;
          expect(projected[index]).not.toHaveProperty('subjectRelation');
        } else {
          usersets += 1;
          expect(projected[index]?.subjectRelation).toBe(row.subjectRelation);
        }
      }
    }
    expect(directSubjects).toBeGreaterThan(0);
    expect(usersets).toBeGreaterThan(0);
  }),
);
