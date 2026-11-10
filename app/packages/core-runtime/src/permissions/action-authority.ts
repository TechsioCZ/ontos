import { DateTime, Effect, Layer, Result } from 'effect';

import { ActionPermissionCheckError } from '../actions/errors.ts';
import {
  decodeAccessActor,
  decodeAccessDeclaration,
  decodeAccessWorkload,
} from '../authorization/access-declaration.ts';
import type { AccessDeclarationOwner } from '../authorization/access-declaration.ts';
import type { AccessDecisionGate, GateCarrier, GateInput } from '../access/enforcement/contract.ts';
import { withOptional } from '../access/decision/optional.ts';
import { coreActionCatalog } from '../modules/actions/catalog.ts';
import {
  ActiveApplicationCompositionService,
  validateActiveApplicationCompositionSnapshot,
} from '../modules/active-application-composition.ts';
import { buildApplicationCompositionCatalog } from '../modules/application-composition-catalog.ts';
import type { InstalledModuleCatalog } from '../modules/catalog.ts';
import type { OntosActionContract } from '../modules/manifest.ts';
import type { OperationalScope } from '../operations/context.ts';
import type { LegalEntityScope } from '../operations/legal-entity-scope.ts';
import { bindLiveAccessGate } from '../operations/access-gate.ts';
import type { AccessDecisionRequirements } from '../operations/access-gate.ts';
import { ActionAuthority } from './action-authority-contract.ts';
import type { ActionAuthorityService, ScopedActionAuthority } from './action-authority-contract.ts';
import type { ActionPermissionDecision } from './service.ts';

/**
 * The canonical Action-authority seam. Its tag and types live in `./action-authority-contract.ts` so a
 * caller that only needs the service identifier never imports the Action catalog; the live
 * implementation below resolves each Action key against the installed catalog through the one gate.
 */
export { ActionAuthority } from './action-authority-contract.ts';
export type {
  ActionAuthorityQuery,
  ActionAuthorityService,
  ScopedActionAuthority,
} from './action-authority-contract.ts';

/**
 * One Action's declared authority, resolved from the installed catalog: the exact carrier the
 * descriptor carries and the legal-entity scope it was declared with. It is the bridge between the
 * Action key a caller knows and the one v2 question the gate answers.
 */
export interface DeclaredActionAuthority {
  readonly actionKey: string;
  readonly carrier: GateCarrier;
  readonly legalEntityScope: LegalEntityScope;
}

/**
 * The decoded carrier of one descriptor, in the exact shape the gate decides with. Core's own
 * registrations and an installed manifest both expose a carrier whose authored spellings (plain caller
 * app IDs, a plain access key) still have to be decoded into the frozen, branded form the gate reads; an
 * installed contract carries one already decoded and re-decoding it is a no-op. Definition time already
 * validated every carrier against its entrypoint, so a value that no longer decodes is a Core defect: it
 * is dropped, and the gate then refuses that Action (`deny.declaration_missing`, `deny.actor_forbidden`)
 * instead of admitting an unproved call.
 */
const declaredCarrierOf = (descriptor: {
  readonly accessActor?: unknown;
  readonly accessDeclaration?: unknown;
  readonly accessWorkload?: unknown;
  readonly entrypoint: AccessDeclarationOwner;
}): GateCarrier => {
  const owner = descriptor.entrypoint;
  const declaration =
    descriptor.accessDeclaration === undefined
      ? undefined
      : Result.getOrUndefined(decodeAccessDeclaration(descriptor.accessDeclaration, owner));
  const actor =
    descriptor.accessActor === undefined
      ? undefined
      : Result.getOrUndefined(decodeAccessActor(descriptor.accessActor, owner));
  const workload =
    descriptor.accessWorkload === undefined
      ? undefined
      : Result.getOrUndefined(decodeAccessWorkload(descriptor.accessWorkload, owner));
  return Object.freeze(
    withOptional(
      withOptional(withOptional({}, 'accessActor', actor), 'accessDeclaration', declaration),
      'accessWorkload',
      workload,
    ),
  );
};

const carrierOfContract = (contract: OntosActionContract): GateCarrier => declaredCarrierOf(contract);

const carrierOfCoreDescriptor = (descriptor: (typeof coreActionCatalog)[number]): GateCarrier =>
  declaredCarrierOf(descriptor);

/** Every Action the runtime can decide, Core's own and the installed modules' alike. */
export const declaredActionAuthorities = (
  catalog: InstalledModuleCatalog,
): ReadonlyMap<string, DeclaredActionAuthority> => {
  const declared = new Map<string, DeclaredActionAuthority>();
  for (const descriptor of coreActionCatalog) {
    declared.set(
      descriptor.actionKey,
      Object.freeze({
        actionKey: descriptor.actionKey,
        carrier: carrierOfCoreDescriptor(descriptor),
        legalEntityScope: descriptor.legalEntityScope,
      }),
    );
  }
  for (const { manifest } of catalog.contracts) {
    for (const action of manifest.publicSurface.actions) {
      declared.set(
        action.actionKey,
        Object.freeze({
          actionKey: action.actionKey,
          carrier: carrierOfContract(action),
          legalEntityScope: action.legalEntityScope,
        }),
      );
    }
  }
  return declared;
};

/** An Action the installed catalog does not declare is decided with no carrier: the gate denies it. */
const UNDECLARED_CARRIER: GateCarrier = Object.freeze({});

const authorityUnavailable = (cause?: unknown): ActionPermissionCheckError => {
  const failure = new ActionPermissionCheckError({
    code: 'action_permission_check_failed',
    reason: 'Action authority could not be decided',
  });
  return cause === undefined
    ? failure
    : Object.defineProperty(failure, 'cause', {
        configurable: false,
        enumerable: false,
        value: cause,
        writable: false,
      });
};

/** The gate's outcome as the two Action questions; UNAVAILABLE is a retryable failure, never a denial. */
const actionDecisions = (
  outcome: 'ALLOWED' | 'DENIED' | 'NEEDS_APPROVAL' | 'UNAVAILABLE',
): Readonly<{ execute: ActionPermissionDecision; propose: ActionPermissionDecision }> | undefined => {
  if (outcome === 'UNAVAILABLE') {
    return undefined;
  }
  return Object.freeze({
    execute: outcome === 'ALLOWED' ? ('allowed' as const) : ('denied' as const),
    propose: outcome === 'DENIED' ? ('denied' as const) : ('allowed' as const),
  });
};

/**
 * The Action-authority seam over the one access gate. It resolves each Action key to its declared
 * carrier and asks the gate the same question every other protected entrypoint asks; a decision that
 * cannot be proven is a retryable failure, never an allow and never a second engine.
 */
export const makeActionAuthorityService = ({
  declared,
  gate,
  now,
}: {
  readonly declared: ReadonlyMap<string, DeclaredActionAuthority>;
  readonly gate: Pick<(typeof AccessDecisionGate)['Service'], 'decide'> &
    Partial<Pick<(typeof AccessDecisionGate)['Service'], 'decideMany'>>;
  readonly now: Date;
}): ActionAuthorityService => {
  const questionOf = (authority: DeclaredActionAuthority | undefined, scope: OperationalScope): GateInput => ({
    carrier: authority?.carrier ?? UNDECLARED_CARRIER,
    legalEntityScope: authority?.legalEntityScope ?? 'optional',
    now,
    scope,
  });

  /**
   * Every named Action in ONE gate batch: the actor, scope and intent are read once and every question is answered
   * in one engine snapshot, each exactly as a single decision and with its own evidence row. A seam that cannot
   * answer a batch decides nothing.
   */
  const checkActionAuthorities: ActionAuthorityService['checkActionAuthorities'] = Effect.fn(
    'ActionAuthority.checkActionAuthorities',
  )(function* checkActionAuthorities(input) {
    if (input.actionKeys.length === 0) {
      return Object.freeze([]);
    }
    if (gate.decideMany === undefined) {
      return yield* authorityUnavailable('The access gate cannot answer an Action batch');
    }
    const decided = yield* gate.decideMany(
      input.actionKeys.map((actionKey) => questionOf(declared.get(actionKey), input.scope)),
    );
    if (decided.length !== input.actionKeys.length) {
      return yield* authorityUnavailable('The access gate returned an incomplete Action batch');
    }
    const answers: ScopedActionAuthority[] = [];
    for (const [index, actionKey] of input.actionKeys.entries()) {
      const outcome = decided[index]?.outcome;
      const decisions = outcome === undefined ? undefined : actionDecisions(outcome);
      if (decisions === undefined) {
        return yield* authorityUnavailable();
      }
      answers.push(Object.freeze({ actionKey, execute: decisions.execute, propose: decisions.propose }));
    }
    return Object.freeze(answers);
  });

  const checkActionProposalPermission: ActionAuthorityService['checkActionProposalPermission'] = Effect.fn(
    'ActionAuthority.checkProposal',
  )(function* checkActionProposalPermission(input) {
    const decision = yield* gate.decide(questionOf(declared.get(input.actionKey), input.scope));
    const decisions = actionDecisions(decision.outcome);
    return decisions === undefined ? yield* authorityUnavailable() : decisions.propose;
  });

  return Object.freeze({ checkActionAuthorities, checkActionProposalPermission });
};

/**
 * The gate as the Action-authority seam uses it, resolved once at wiring (CUTOVER-PLAN §3.1). The
 * carrier index is rebuilt per call from the active composition, so an installed module's Action is
 * decided by exactly the declaration it published and a withdrawn one denies.
 */
export const ActionAuthorityLive: Layer.Layer<
  ActionAuthority,
  never,
  // The gate is the seam; its five enforcement ports and the active composition are what the binding
  // reads through, so the application root provides exactly these (CUTOVER-PLAN §3.1 step 8).
  AccessDecisionGate | AccessDecisionRequirements | ActiveApplicationCompositionService
> = Layer.effect(
  ActionAuthority,
  Effect.gen(function* makeActionAuthorityLive() {
    const gate = yield* bindLiveAccessGate;
    const batchGate =
      gate.decideMany === undefined ? { decide: gate.decide } : { decide: gate.decide, decideMany: gate.decideMany };
    const composition = yield* ActiveApplicationCompositionService;
    const withDeclared = <Value, Failure, Requirements>(
      body: (declared: ReadonlyMap<string, DeclaredActionAuthority>) => Effect.Effect<Value, Failure, Requirements>,
    ) =>
      composition.load.pipe(
        Effect.flatMap(validateActiveApplicationCompositionSnapshot),
        Effect.flatMap((snapshot) => buildApplicationCompositionCatalog(snapshot.composition)),
        Effect.mapError(authorityUnavailable),
        Effect.flatMap((catalog) => body(declaredActionAuthorities(catalog))),
      );
    const nowDate = DateTime.nowAsDate;
    return Object.freeze<ActionAuthorityService>({
      checkActionAuthorities: (input) =>
        nowDate.pipe(
          Effect.flatMap((now) =>
            withDeclared((declared) =>
              makeActionAuthorityService({ declared, gate: batchGate, now }).checkActionAuthorities(input),
            ),
          ),
        ),
      checkActionProposalPermission: (input) =>
        nowDate.pipe(
          Effect.flatMap((now) =>
            withDeclared((declared) =>
              makeActionAuthorityService({ declared, gate: batchGate, now }).checkActionProposalPermission(input),
            ),
          ),
        ),
    });
  }),
);
