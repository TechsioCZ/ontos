import { Option, Predicate, Schema } from 'effect';

import type { AccessDeclaration } from '../../authorization/access-declaration.ts';
import type { OperationalScope } from '../../operations/context.ts';
import type { LegalEntityScope } from '../../operations/legal-entity-scope.ts';
import type { AccessAmount, DecisionCapabilityPolicy } from '../decision/contract.ts';
import type { LegalEntityId } from '../ids.ts';
import { CapabilityKeySchema, CurrencyCodeSchema, LegalEntityIdSchema } from '../ids.ts';
import { withOptional } from '../decision/optional.ts';
import type { DecisionReason } from '../model.ts';

/**
 * The decision half of a declaration (CUTOVER-PLAN §3.1 step 3). Nothing here reads a database:
 * the compiler pins role cells to the catalog snapshot, so the capability policy is a straight
 * projection of the declaration the descriptor was validated with (guarantee 2).
 */
export const capabilityPolicyOf = (declaration: AccessDeclaration): DecisionCapabilityPolicy =>
  withOptional(
    withOptional(
      withOptional(
        {
          capabilityKey: CapabilityKeySchema.make(declaration.key),
          kind: declaration.kind,
          modes: declaration.modes,
          risk: declaration.risk,
          selectors: declaration.selectors,
        },
        'ephemeral',
        declaration.ephemeral,
      ),
      'fieldClass',
      declaration.fieldClass,
    ),
    // O88: the surface marker of a page reaches the engine only through the declaration, so no
    // caller flag, key prefix or selected company can ever stand in for it.
    'admitsAdminSurface',
    declaration.admitsAdminSurface,
  );

/** One scalar money value: minor units of one currency, as the amount caveat reads it (O18). */
const AccessAmountSchema = Schema.Struct({
  currency: CurrencyCodeSchema,
  minor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
const decodeAccessAmount = Schema.decodeUnknownOption(AccessAmountSchema);
const asJson = Schema.decodeUnknownOption(Schema.Json);

/** One member of a property path, kept JSON-typed so no step of the walk trusts a declared shape. */
const jsonMember = (root: Schema.Json, segments: readonly string[]): Option.Option<Schema.Json> => {
  let cursor: Option.Option<Schema.Json> = Option.some(root);
  for (const segment of segments) {
    const current = Option.getOrUndefined(cursor);
    cursor = current === undefined || !Predicate.isObject(current) ? Option.none() : asJson(current[segment]);
  }
  return cursor;
};

/**
 * The governed money value a declaration names through `amountInput` (O18).
 *
 * A payload value that is absent or is not exactly one scalar money value yields no amount, which
 * the engine refuses as `deny.amount_required` exactly when a grant or connection ceiling applies:
 * an unreadable amount can never be read as "no limit" (guarantee 9). A declaration without
 * `amountInput` governs no amount at all.
 */
export const accessAmountAt = <Payload>(payload: Payload, path: string): AccessAmount | undefined => {
  const decoded = asJson(payload);
  if (Option.isNone(decoded)) {
    return undefined;
  }
  const value = jsonMember(decoded.value, path.split('.'));
  if (Option.isNone(value)) {
    return undefined;
  }
  const amount = decodeAccessAmount(value.value);
  return Option.isNone(amount) ? undefined : { currency: amount.value.currency, minor: amount.value.minor };
};

/**
 * The amount this request is governed by: the declaration's own `amountInput` path, read from the
 * payload the entrypoint just decoded. An owner-side derived total (O18 `derived.*`) is handed to
 * the seam directly instead, because only the owner knows how to compute it.
 */
export const gateAmountOf = <Payload>(declaration: AccessDeclaration, payload: Payload): AccessAmount | undefined =>
  declaration.amountInput === undefined ? undefined : accessAmountAt(payload, declaration.amountInput);

/**
 * The v2 scope one request is decided in (O7, O12, O28, O88). Exactly one context, never a wildcard:
 * a request that names its company is decided in that company, whatever the declaration's kind — an
 * operation on one company's data or roles names the target company, and that is where its access
 * administrator holds their power. Tenant-wide administration names no company and runs in the tenant
 * context, so it never depends on a company selection. The declaration itself no longer changes the
 * scope: its own `selectors` and the entrypoint's `legalEntityScope` already say what it reaches.
 */
export interface GateScope {
  readonly legalEntityId?: LegalEntityId;
  readonly refusal?: DecisionReason;
}

export const gateScopeOf = (legalEntityScope: LegalEntityScope, scope: OperationalScope): GateScope => {
  if (legalEntityScope === 'required') {
    const { legalEntityId } = scope;
    return legalEntityId === undefined
      ? { refusal: { code: 'deny.scope_mismatch' } }
      : { legalEntityId: LegalEntityIdSchema.make(legalEntityId) };
  }
  // `optional` and `forbidden` run in the tenant context (O7, O12, O67-Q3).
  return {};
};
