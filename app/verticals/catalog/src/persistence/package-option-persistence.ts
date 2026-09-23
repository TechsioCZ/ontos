import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Match, Option, Schema } from 'effect';

import { assessPackageOption } from '../../shared/domain/package-option.ts';
import { CatalogRevisionNumberSchema } from '../../shared/domain/catalog-revision-reference.ts';
import { resolveEffectiveRevision } from './package-persistence.ts';
import {
  packageContentRevisions,
  packageDefinitions,
  packageOptionRoleRevisions,
  productUnits,
  productVariants,
  products,
} from '../database/schema.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
type Definition = typeof packageDefinitions.$inferSelect;
type Content = typeof packageContentRevisions.$inferSelect;
const packageType = 'commerce.catalog.package-definition';
const moduleId = 'commerce.catalog';
const TransitionSchema = Schema.Literals(['ACTIVATE', 'RETIRE']);
type Transition = typeof TransitionSchema.Type;

export class PackageOptionPersistenceUnavailable extends Schema.TaggedError<PackageOptionPersistenceUnavailable>()(
  'PackageOptionPersistenceUnavailable',
  { code: Schema.Literal('package_option_persistence_unavailable'), reason: Schema.String },
) {}

export interface PackageOptionRoleFinding {
  readonly evidenceRefs: readonly string[];
  readonly independentlyRequested: boolean;
  readonly looseUnitsSubstitutable: boolean;
  readonly validationReason: string;
}

/** The owner verifies the legitimate request, not merely caller-supplied booleans or codes. */
export interface PackageOptionRoleBasis {
  readonly verify: (input: {
    readonly contentRevision: number;
    readonly packageDefinitionId: string;
    readonly productId: string;
    readonly tenantId: string;
    readonly variantId: string;
  }) => Effect.Effect<Option.Option<PackageOptionRoleFinding>, PackageOptionPersistenceUnavailable>;
}

/** #479 must prove that a role transition does not silently reinterpret open selections. */
export interface PackageOptionSelectionImpact {
  readonly verify: (input: {
    readonly contentRevision: number;
    readonly packageDefinitionId: string;
    readonly tenantId: string;
    readonly transition: Transition;
  }) => Effect.Effect<boolean, PackageOptionPersistenceUnavailable>;
}

interface PackageOptionTransitionInput {
  readonly actionInvocationId: string;
  readonly expectedContentRevision: number;
  readonly expectedOptionRevision: number;
  readonly packageDefinitionId: string;
}

const PackageOptionTransitionOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('changed', {
    contentRevision: Schema.Int,
    optionRevision: Schema.Int,
    state: Schema.Literals(['ACTIVE', 'RETIRED']),
  }),
  Schema.TaggedStruct('invalid', { reason: Schema.String }),
  Schema.TaggedStruct('not_found', {}),
  Schema.TaggedStruct('stale', { actualContentRevision: Schema.Int, actualOptionRevision: Schema.Int }),
]);
type PackageOptionTransitionOutcome = typeof PackageOptionTransitionOutcomeSchema.Type;

export interface PackageOptionPersistence {
  readonly activate: (
    input: PackageOptionTransitionInput,
  ) => Effect.Effect<PackageOptionTransitionOutcome, PackageOptionPersistenceUnavailable>;
  readonly retire: (
    input: PackageOptionTransitionInput,
  ) => Effect.Effect<PackageOptionTransitionOutcome, PackageOptionPersistenceUnavailable>;
}

const unavailable = (cause?: unknown): PackageOptionPersistenceUnavailable => {
  const error = new PackageOptionPersistenceUnavailable({
    code: 'package_option_persistence_unavailable',
    reason: 'Authoritative Package Option basis or persistence is unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(error, 'cause', { configurable: true, value: cause });
  }
  return error;
};

/** An Option role revision is distinct from its pinned Package content revision. */
export const packageOptionHistoryForScope = (transaction: ScopedTransaction, scope: OperationalScope) => ({
  getRoleRevision: (definitionId: string, revision: number) =>
    transaction
      .select()
      .from(packageOptionRoleRevisions)
      .where(
        and(
          eq(packageOptionRoleRevisions.tenantId, scope.tenantId),
          eq(packageOptionRoleRevisions.packageDefinitionId, definitionId),
          eq(packageOptionRoleRevisions.revision, revision),
        ),
      )
      .limit(1)
      .pipe(
        Effect.map((rows) => (rows[0] === undefined ? Option.none() : Option.some(rows[0]))),
        Effect.mapError(unavailable),
      ),
});

export const validPackageOptionRoleFinding = (finding: PackageOptionRoleFinding): boolean =>
  finding.validationReason.length > 0 &&
  finding.validationReason.length <= 1000 &&
  finding.validationReason === finding.validationReason.trim() &&
  finding.evidenceRefs.length > 0 &&
  finding.evidenceRefs.every((ref) => ref.length > 0 && ref.length <= 1000 && ref === ref.trim());

const invalidInput = (input: PackageOptionTransitionInput): boolean =>
  !Number.isSafeInteger(input.expectedOptionRevision) ||
  input.expectedOptionRevision < 0 ||
  !Number.isSafeInteger(input.expectedContentRevision) ||
  input.expectedContentRevision < 1 ||
  input.packageDefinitionId.length === 0 ||
  input.actionInvocationId.length === 0;

const invalidCurrent = (row: Definition, content: Content | undefined): boolean =>
  content === undefined ||
  content.productId !== row.productId ||
  content.variantId !== row.variantId ||
  content.unitResourceType !== 'commerce.catalog.product-unit';

const inactiveCurrent = (
  row: Definition,
  content: Content,
  productLifecycle: string,
  variantLifecycle: string,
  unitLifecycle: string,
): boolean =>
  row.lifecycleState !== 'ACTIVE' ||
  content.lifecycleState !== 'ACTIVE' ||
  productLifecycle !== 'ACTIVE' ||
  variantLifecycle !== 'ACTIVE' ||
  unitLifecycle !== 'ACTIVE';

const stateProblem = (kind: Transition, state: string): string | undefined => {
  if (kind === 'RETIRE' && state !== 'ACTIVE') {
    return 'Package Option is not active';
  }
  if (kind === 'ACTIVATE' && state === 'ACTIVE') {
    return 'Package Option is already active';
  }
  return undefined;
};

const requiresActiveCurrent = (
  kind: Transition,
  row: Definition,
  content: Content,
  productLifecycle: string,
  variantLifecycle: string,
  unitLifecycle: string,
): boolean => kind === 'ACTIVATE' && inactiveCurrent(row, content, productLifecycle, variantLifecycle, unitLifecycle);

const optionOf = <T>(value: T | undefined): Option.Option<T> =>
  value === undefined ? Option.none() : Option.some(value);

const trustedFinding = (candidate: Option.Option<PackageOptionRoleFinding>): Option.Option<PackageOptionRoleFinding> =>
  Option.isSome(candidate) && validPackageOptionRoleFinding(candidate.value) ? candidate : Option.none();

const effectiveContent = (contents: readonly Content[], row: Definition, at: Date): Content | undefined => {
  if (contents.length < row.currentRevision || contents.length > row.currentRevision + 1) {
    return undefined;
  }
  const resolved = resolveEffectiveRevision(contents, at);
  return Option.getOrUndefined(
    Match.value(resolved).pipe(
      Match.tag('resolved', (value) => optionOf(contents.find((candidate) => candidate.revision === value.revision))),
      Match.orElse(() => Option.none<Content>()),
    ),
  );
};

const findingForTransition = Effect.fn('PackageOptionPersistence.findingForTransition')(function* findingForTransition(
  kind: Transition,
  transaction: ScopedTransaction,
  tenantId: string,
  row: Definition,
  effectiveRevision: number,
  roleBasis: PackageOptionRoleBasis | undefined,
) {
  if (kind === 'ACTIVATE') {
    return roleBasis === undefined
      ? Option.none()
      : yield* roleBasis.verify({
          contentRevision: effectiveRevision,
          packageDefinitionId: row.packageDefinitionId,
          productId: row.productId,
          tenantId,
          variantId: row.variantId,
        });
  }
  const [prior] = yield* transaction
    .select()
    .from(packageOptionRoleRevisions)
    .where(
      and(
        eq(packageOptionRoleRevisions.tenantId, tenantId),
        eq(packageOptionRoleRevisions.packageDefinitionId, row.packageDefinitionId),
        eq(packageOptionRoleRevisions.revision, row.currentOptionRevision),
      ),
    )
    .limit(1)
    .pipe(Effect.mapError(unavailable));
  if (
    prior?.state !== 'ACTIVE' ||
    !Number.isSafeInteger(prior.contentRevision) ||
    prior.contentRevision <= 0 ||
    prior.contentRevision > effectiveRevision ||
    prior.productId !== row.productId ||
    prior.variantId !== row.variantId
  ) {
    return Option.none();
  }
  return Option.some({
    evidenceRefs: prior.evidenceRefs,
    independentlyRequested: prior.independentlyRequested,
    looseUnitsSubstitutable: prior.looseUnitsSubstitutable,
    validationReason: 'Retired previously attested Package Option role',
  });
});

/** The Core-scoped transaction owns atomicity; this service never creates a transaction. */
export const packageOptionPersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
  roleBasis?: PackageOptionRoleBasis,
  selectionImpact?: PackageOptionSelectionImpact,
): PackageOptionPersistence => {
  const { tenantId } = scope;
  const loadDefinition = (id: string) =>
    transaction
      .select()
      .from(packageDefinitions)
      .where(and(eq(packageDefinitions.tenantId, tenantId), eq(packageDefinitions.packageDefinitionId, id)))
      .for('update')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
  const loadContents = (id: string) =>
    transaction
      .select()
      .from(packageContentRevisions)
      .where(and(eq(packageContentRevisions.tenantId, tenantId), eq(packageContentRevisions.packageDefinitionId, id)))
      .pipe(Effect.mapError(unavailable));
  const loadProduct = (id: string) =>
    transaction
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.productId, id)))
      .for('update')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
  const loadVariant = (row: Definition) =>
    transaction
      .select()
      .from(productVariants)
      .where(
        and(
          eq(productVariants.tenantId, tenantId),
          eq(productVariants.productId, row.productId),
          eq(productVariants.variantId, row.variantId),
        ),
      )
      .for('update')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
  const loadUnit = (content: Content) =>
    transaction
      .select()
      .from(productUnits)
      .where(and(eq(productUnits.tenantId, tenantId), eq(productUnits.unitId, content.unitResourceId)))
      .for('update')
      .limit(1)
      .pipe(Effect.mapError(unavailable));

  const transition = Effect.fn('PackageOptionPersistence.transition')(function* transition(
    kind: Transition,
    input: PackageOptionTransitionInput,
  ) {
    if (invalidInput(input)) {
      return { _tag: 'invalid' as const, reason: 'Invalid Package Option transition references' };
    }
    const [row] = yield* loadDefinition(input.packageDefinitionId);
    if (row === undefined) {
      return { _tag: 'not_found' as const };
    }
    const now = DateTime.toDateUtc(yield* DateTime.now);
    const contents = yield* loadContents(row.packageDefinitionId);
    const content = effectiveContent(contents, row, now);
    if (content === undefined || invalidCurrent(row, content)) {
      return yield* unavailable();
    }
    const effectiveRevision = content.revision;
    if (
      effectiveRevision !== input.expectedContentRevision ||
      effectiveRevision !== row.currentRevision ||
      row.currentOptionRevision !== input.expectedOptionRevision
    ) {
      return {
        _tag: 'stale' as const,
        actualContentRevision: effectiveRevision,
        actualOptionRevision: row.currentOptionRevision,
      };
    }
    const authorityMissing = selectionImpact === undefined || (kind === 'ACTIVATE' && roleBasis === undefined);
    if (authorityMissing) {
      return yield* unavailable();
    }
    // One scoped transaction/connection: keep row locks deterministic, not concurrent.
    const [[loadedProduct], [loadedVariant], [loadedUnit]] = yield* Effect.all(
      [loadProduct(row.productId), loadVariant(row), loadUnit(content)] as const,
      { concurrency: 1 },
    );
    const current = Option.all([optionOf(loadedProduct), optionOf(loadedVariant), optionOf(loadedUnit)] as const);
    if (Option.isNone(current)) {
      return yield* unavailable();
    }
    const [product, variant, unit] = current.value;
    if (
      requiresActiveCurrent(kind, row, content, product.lifecycleState, variant.lifecycleState, unit.lifecycleState)
    ) {
      return { _tag: 'invalid' as const, reason: 'Package Definition and Current parents must be active' };
    }
    const problem = stateProblem(kind, row.optionState);
    if (problem !== undefined) {
      return { _tag: 'invalid' as const, reason: problem };
    }
    const candidateFinding = yield* findingForTransition(
      kind,
      transaction,
      tenantId,
      row,
      effectiveRevision,
      roleBasis,
    );
    const findingOption = trustedFinding(candidateFinding);
    if (Option.isNone(findingOption)) {
      return { _tag: 'invalid' as const, reason: 'Independent role evidence is invalid' };
    }
    const finding = findingOption.value;
    if (kind === 'ACTIVATE') {
      const contentRevision = yield* Schema.decodeEffect(CatalogRevisionNumberSchema)(effectiveRevision).pipe(
        Effect.mapError(unavailable),
      );
      const decision = assessPackageOption(
        {
          currentContent: {
            resourceRef: {
              moduleId,
              resourceId: row.packageDefinitionId,
              resourceType: packageType,
              tenantId,
            },
            revision: contentRevision,
          },
          definitionRef: {
            moduleId,
            resourceId: row.packageDefinitionId,
            resourceType: packageType,
            tenantId,
          },
          form: {
            productRef: {
              moduleId,
              resourceId: row.productId,
              resourceType: 'commerce.catalog.product',
              tenantId,
            },
            variantRef: {
              moduleId,
              resourceId: row.variantId,
              resourceType: 'commerce.catalog.variant',
              tenantId,
            },
          },
          independentlyRequested: finding.independentlyRequested,
          lifecycle: 'ACTIVE',
          substitutionWithLooseQuantitySatisfiesRequest: finding.looseUnitsSubstitutable,
        },
        'ACTIVE',
        'ACTIVE',
      );
      if (decision.status !== 'SELECTABLE') {
        return { _tag: 'invalid' as const, reason: decision.reason };
      }
    }
    if (
      !(yield* selectionImpact.verify({
        contentRevision: effectiveRevision,
        packageDefinitionId: row.packageDefinitionId,
        tenantId,
        transition: kind,
      }))
    ) {
      return { _tag: 'invalid' as const, reason: 'Open Catalog selections need explicit remediation' };
    }
    const state = kind === 'ACTIVATE' ? ('ACTIVE' as const) : ('RETIRED' as const);
    const revision = row.currentOptionRevision + 1;
    const [updated] = yield* transaction
      .update(packageDefinitions)
      .set({ currentOptionRevision: revision, optionState: state, updatedAt: now })
      .where(
        and(
          eq(packageDefinitions.tenantId, tenantId),
          eq(packageDefinitions.packageDefinitionId, row.packageDefinitionId),
          eq(packageDefinitions.currentRevision, row.currentRevision),
          eq(packageDefinitions.currentOptionRevision, row.currentOptionRevision),
        ),
      )
      .returning()
      .pipe(Effect.mapError(unavailable));
    if (updated === undefined) {
      return {
        _tag: 'stale' as const,
        actualContentRevision: effectiveRevision,
        actualOptionRevision: row.currentOptionRevision,
      };
    }
    yield* transaction
      .insert(packageOptionRoleRevisions)
      .values({
        actingPrincipalId: scope.principalId,
        actionInvocationId: input.actionInvocationId,
        contentRevision: effectiveRevision,
        effectiveAt: now,
        evidenceRefs: [...finding.evidenceRefs],
        independentlyRequested: finding.independentlyRequested,
        looseUnitsSubstitutable: finding.looseUnitsSubstitutable,
        packageDefinitionId: row.packageDefinitionId,
        productId: row.productId,
        revision,
        state,
        tenantId,
        validationReason: finding.validationReason,
        variantId: row.variantId,
      })
      .pipe(Effect.mapError(unavailable));
    return { _tag: 'changed' as const, contentRevision: effectiveRevision, optionRevision: revision, state };
  });
  return {
    activate: (input) => transition('ACTIVATE', input),
    retire: (input) => transition('RETIRE', input),
  };
};
