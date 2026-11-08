import { Context } from 'effect';
import type { Effect } from 'effect';

import type { OperationalScope } from '../../operations/context.ts';
import type { LegalEntityScope } from '../../operations/legal-entity-scope.ts';
import type { AccessAmount, AccessDecision, AccessRecordTarget, ParentReadRequirement } from '../decision/contract.ts';
import type { ListAccessPredicate } from '../decision/list-access.ts';
import type { AccessMode } from '../model.ts';
import type { GateCarrier } from './contract.ts';

import type { SubjectInspectionUnavailable } from './inspection-unavailable.ts';

/** A subject identity, NOT authentication, an execution scope, a lease or a permit. */
export interface InspectionSubject {
  /** Exact credential-bound consent context. Never use an OAuth grant id as a connection id. */
  readonly agentContext?: {
    readonly connectionId: string;
    readonly consentRevision: number;
    /** The human named by this specific persisted connection, not the evaluator. */
    readonly principalId: string;
  };
  readonly principalId: string;
  readonly tenantId: string;
}

export interface SubjectInspectionInput {
  /** Queried context, never authentication. Must exactly match the evaluator's selected context. */
  readonly queryScope: {
    readonly legalEntityId?: string;
    readonly tenantId: string;
  };
  /** The original authenticated evaluator object. Every database/kind/evidence port receives it unchanged. */
  readonly requesterScope: OperationalScope;
  readonly subject: InspectionSubject;
}

export interface SubjectCapabilityInspectionInput extends SubjectInspectionInput {
  readonly amount?: AccessAmount;
  readonly carrier: GateCarrier;
  readonly legalEntityScope: LegalEntityScope;
  readonly mode?: AccessMode;
  readonly parentRead?: ParentReadRequirement;
  readonly target?: AccessRecordTarget;
}

export interface SubjectCapabilityInspection {
  readonly decision: AccessDecision;
  readonly inspectionOnly: true;
}

export interface SubjectListInspection {
  readonly decision: AccessDecision;
  readonly inspectionOnly: true;
  readonly predicate?: ListAccessPredicate;
}

export interface SubjectScopeInspection {
  readonly decision: 'allowed' | 'denied';
  readonly inspectionOnly: true;
  readonly reasonCodes: readonly string[];
}

export interface SubjectActionInspection {
  readonly authorities: readonly {
    readonly actionKey: string;
    readonly propose: 'allowed' | 'denied';
    readonly run: 'allowed' | 'denied';
  }[];
  readonly inspectionOnly: true;
}

export { SubjectInspectionUnavailable } from './inspection-unavailable.ts';

/** Projection only. Callers must still use the governed operation's normal execution admission. */
export interface SubjectAccessInspectionService {
  readonly actions: (
    input: SubjectInspectionInput & { readonly actionKeys: readonly string[] },
  ) => Effect.Effect<SubjectActionInspection, SubjectInspectionUnavailable>;
  readonly inspect: (
    input: SubjectCapabilityInspectionInput,
  ) => Effect.Effect<SubjectCapabilityInspection, SubjectInspectionUnavailable>;
  readonly list: (
    input: SubjectCapabilityInspectionInput,
  ) => Effect.Effect<SubjectListInspection, SubjectInspectionUnavailable>;
  /** Inspect selection of the requester's EXACT company, or tenant membership when it has no company. */
  readonly scope: (
    input: SubjectInspectionInput,
  ) => Effect.Effect<SubjectScopeInspection, SubjectInspectionUnavailable>;
}

export class SubjectAccessInspection extends Context.Service<SubjectAccessInspection, SubjectAccessInspectionService>()(
  '@app/core-runtime/access/enforcement/inspection-contract/SubjectAccessInspection',
) {}
