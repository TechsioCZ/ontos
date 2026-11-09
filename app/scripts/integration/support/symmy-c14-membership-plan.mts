import { ApplyCustomerGroupMembershipSourcePayloadSchema } from '@app/commerce-customer-context/api/apply-customer-group-membership-source-action';
import { SymmyInternalExecutionPlanSchema } from '@app/symmy-integration/symmy-internal-contracts';
import { Effect, Schema } from 'effect';

const [assignmentSchema] = ApplyCustomerGroupMembershipSourcePayloadSchema.members;

/** Explicit PERSON assignment only; omission never becomes removal or a complete snapshot. */
export const makeInternalMembershipAssignmentPlan = (payload: typeof assignmentSchema.Encoded) =>
  Schema.decodeUnknownEffect(assignmentSchema)(payload).pipe(
    Effect.flatMap(Schema.encodeEffect(assignmentSchema)),
    Effect.flatMap((normalized) =>
      Schema.decodeUnknownEffect(SymmyInternalExecutionPlanSchema)({
        items: [
          {
            effects: [
              {
                effectKey: 'customer-group-assignment',
                intent: { _tag: 'CustomerGroupMembership', payload: normalized },
                operation: {
                  entrypointKey: 'commerce.customer-context.apply-customer-group-membership-source',
                  moduleId: 'commerce.customer-context',
                  schemaVersion: '1',
                },
                originalTarget: normalized.profile.profileRef,
              },
            ],
            itemKey: 'customer-group-assignment',
            source: {
              entityKind: normalized.manager.factFamily,
              issuerId: normalized.manager.issuer,
              sourceNamespace: normalized.manager.sourceNamespace,
              sourceRecordId: normalized.source.sourceRecordId,
            },
            sourceOccurrenceId: normalized.source.assertionId,
          },
        ],
      }),
    ),
  );
