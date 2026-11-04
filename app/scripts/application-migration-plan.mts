import { Effect, Schema } from 'effect';

const ownerId = Schema.NonEmptyString.pipe(Schema.brand('ApplicationMigrationOwnerId'), Schema.decodeTo(Schema.String));
const migrationName = Schema.String.check(Schema.isPattern(/^[0-9]{14}_[a-zA-Z0-9_-]+$/u)).pipe(
  Schema.brand('ApplicationMigrationName'),
  Schema.decodeTo(Schema.String),
);
const journalName = Schema.String.check(Schema.isPattern(/^__drizzle_migrations_[a-z0-9_]+$/u)).pipe(
  Schema.brand('ApplicationMigrationJournalName'),
  Schema.decodeTo(Schema.String),
);
const schemaName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]*$/u)).pipe(
  Schema.brand('ApplicationMigrationSchemaName'),
  Schema.decodeTo(Schema.String),
);
const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const migrationMode = Schema.Literals(['none', 'selected', 'all']);
const VERIFIED_TARGET = 'verified-target' as const;
const MigrationEntrySchema = Schema.Struct({ hash: digest, name: migrationName });

export const ApplicationMigrationRequirementSchema = Schema.Struct({
  migrate: Schema.Boolean,
  ownerId,
  throughMigration: Schema.optionalKey(migrationName),
  verify: Schema.Boolean,
});
export type ApplicationMigrationRequirement = typeof ApplicationMigrationRequirementSchema.Type;

export const ApplicationMigrationRequirementsSchema = Schema.Struct({
  mode: migrationMode,
  owners: Schema.Array(ApplicationMigrationRequirementSchema),
});
export type ApplicationMigrationRequirements = typeof ApplicationMigrationRequirementsSchema.Type;

/** Source-owned streams from the existing migration inventory; this interface imports no owner configuration. */
export const ApplicationMigrationOwnerInventorySchema = Schema.Struct({
  journalName,
  migrations: Schema.Array(MigrationEntrySchema),
  optional: Schema.Boolean,
  ownerId,
  prerequisites: Schema.Array(ApplicationMigrationRequirementSchema),
  schemas: Schema.Array(schemaName),
});
export type ApplicationMigrationOwnerInventory = typeof ApplicationMigrationOwnerInventorySchema.Type;

/** Native evidence, never a prediction based on which artifact was rebuilt. */
export const ApplicationMigrationObservationSchema = Schema.Struct({
  catalogFingerprint: digest,
  entries: Schema.Array(MigrationEntrySchema),
  journalExists: Schema.Boolean,
  journalName,
  ownerId,
  schemaEvidence: Schema.Literals(['absent', 'observed-journal', VERIFIED_TARGET, 'inconsistent']),
  schemasPresent: Schema.Array(schemaName),
});
export type ApplicationMigrationObservation = typeof ApplicationMigrationObservationSchema.Type;

const PlannedOwnerSchema = Schema.Struct({
  before: ApplicationMigrationObservationSchema,
  migrate: Schema.Boolean,
  ownerId,
  pendingMigrations: Schema.Array(MigrationEntrySchema),
  throughMigration: Schema.optionalKey(migrationName),
  verification: Schema.Literals(['not_requested', 'pending', 'verified']),
  verify: Schema.Boolean,
});
export const ApplicationMigrationPlanSchema = Schema.Struct({
  initializationOwners: Schema.Array(ownerId),
  mode: migrationMode,
  owners: Schema.Array(PlannedOwnerSchema),
  schemaVersion: Schema.Literal(1),
});
export type ApplicationMigrationPlan = typeof ApplicationMigrationPlanSchema.Type;

export class ApplicationMigrationPlanError extends Schema.TaggedError<ApplicationMigrationPlanError>()(
  'ApplicationMigrationPlanError',
  { message: Schema.String },
) {}

const invalid = (message: string) => new ApplicationMigrationPlanError({ message });
const unique = (values: readonly string[]) => new Set(values).size === values.length;
const validRequirement = (requirement: ApplicationMigrationRequirement) =>
  (requirement.migrate || requirement.verify) && (requirement.throughMigration === undefined || requirement.migrate);

const validateInventory = Effect.fn('ApplicationMigrationPlan.validateInventory')(function* validateInventoryEffect(
  inventory: readonly ApplicationMigrationOwnerInventory[],
) {
  if (!unique(inventory.map((owner) => owner.ownerId)) || !unique(inventory.map((owner) => owner.journalName))) {
    return yield* invalid('Each migration owner and independent journal must be declared exactly once');
  }
  const known = new Set(inventory.map((owner) => owner.ownerId));
  for (const owner of inventory) {
    if (
      !unique(owner.schemas) ||
      owner.schemas.length === 0 ||
      !unique(owner.migrations.map((entry) => entry.name)) ||
      owner.migrations.some((entry, index) => index > 0 && entry.name <= (owner.migrations[index - 1]?.name ?? '')) ||
      !unique(owner.prerequisites.map((requirement) => requirement.ownerId)) ||
      owner.prerequisites.some((requirement) => !known.has(requirement.ownerId) || !validRequirement(requirement))
    ) {
      return yield* invalid(`Invalid source migration inventory for ${owner.ownerId}`);
    }
  }
  return new Map(inventory.map((owner) => [owner.ownerId, owner]));
});

const mergeRequirement = (
  existing: ApplicationMigrationRequirement | undefined,
  incoming: ApplicationMigrationRequirement,
): ApplicationMigrationRequirement => {
  if (existing === undefined) {
    return incoming;
  }
  const migrate = existing.migrate || incoming.migrate;
  const verify = existing.verify || incoming.verify;
  const unbounded =
    (existing.migrate && existing.throughMigration === undefined) ||
    (incoming.migrate && incoming.throughMigration === undefined);
  let { throughMigration } = incoming;
  if (
    existing.throughMigration !== undefined &&
    (throughMigration === undefined || existing.throughMigration > throughMigration)
  ) {
    ({ throughMigration } = existing);
  }
  return unbounded || throughMigration === undefined
    ? { migrate, ownerId: incoming.ownerId, verify }
    : { migrate, ownerId: incoming.ownerId, throughMigration, verify };
};

const validateObservation = Effect.fn('ApplicationMigrationPlan.validateObservation')(
  function* validateObservationEffect(
    owner: ApplicationMigrationOwnerInventory,
    observation: ApplicationMigrationObservation,
  ) {
    if (
      observation.journalName !== owner.journalName ||
      !unique(observation.entries.map((entry) => entry.name)) ||
      !unique(observation.schemasPresent) ||
      observation.schemasPresent.some((name) => !owner.schemas.includes(name)) ||
      observation.entries.some((entry) => {
        const source = owner.migrations.find((migration) => migration.name === entry.name);
        return source === undefined || entry.name !== source.name || entry.hash !== source.hash;
      }) ||
      observation.schemaEvidence === 'inconsistent' ||
      (!observation.journalExists && observation.entries.length > 0)
    ) {
      return yield* invalid(`Journal, hash or schema evidence is inconsistent for ${owner.ownerId}`);
    }
    const emptySchema = observation.schemasPresent.length === 0;
    if (
      (observation.schemaEvidence === 'absent' && (!emptySchema || observation.entries.length > 0)) ||
      (observation.schemaEvidence !== 'absent' &&
        (emptySchema || !observation.journalExists || observation.entries.length === 0)) ||
      (observation.schemaEvidence === VERIFIED_TARGET && observation.schemasPresent.length !== owner.schemas.length)
    ) {
      return yield* invalid(`Native schema evidence contradicts the durable journal for ${owner.ownerId}`);
    }
    return yield* Effect.void;
  },
);

const planOwner = Effect.fn('ApplicationMigrationPlan.planOwner')(function* planOwnerEffect(
  owner: ApplicationMigrationOwnerInventory,
  requirement: ApplicationMigrationRequirement,
  before: ApplicationMigrationObservation,
): Effect.fn.Return<ApplicationMigrationPlan['owners'][number], ApplicationMigrationPlanError> {
  yield* validateObservation(owner, before);
  const targetIndex =
    requirement.throughMigration === undefined
      ? owner.migrations.length
      : owner.migrations.findIndex((entry) => entry.name === requirement.throughMigration) + 1;
  const appliedNames = new Set(before.entries.map((entry) => entry.name));
  if (requirement.migrate && owner.migrations.slice(targetIndex).some((entry) => appliedNames.has(entry.name))) {
    return yield* invalid(`Durable journal exceeds the reviewed migration target for ${owner.ownerId}`);
  }
  const pendingMigrations = requirement.migrate
    ? owner.migrations.slice(0, targetIndex).filter((entry) => !appliedNames.has(entry.name))
    : [];
  let verification: ApplicationMigrationPlan['owners'][number]['verification'] = 'not_requested';
  if (requirement.verify) {
    verification = pendingMigrations.length === 0 && before.schemaEvidence === VERIFIED_TARGET ? 'verified' : 'pending';
  }
  const base = {
    before: {
      ...before,
      entries: owner.migrations.filter((entry) => appliedNames.has(entry.name)),
      schemasPresent: owner.schemas.filter((name) => before.schemasPresent.includes(name)),
    },
    migrate: requirement.migrate,
    ownerId: owner.ownerId,
    pendingMigrations,
    verification,
    verify: requirement.verify,
  };
  const throughMigration = requirement.migrate ? owner.migrations[targetIndex - 1]?.name : undefined;
  return throughMigration === undefined ? base : { ...base, throughMigration };
});

/** Resolves only source-owned prerequisites, before any selected configuration or native observation is loaded. */
export const resolveApplicationMigrationRequirements = Effect.fn('ApplicationMigrationPlan.resolveRequirements')(
  function* resolveApplicationMigrationRequirementsEffect(
    requirements: ApplicationMigrationRequirements,
    inventory: readonly ApplicationMigrationOwnerInventory[],
  ): Effect.fn.Return<readonly ApplicationMigrationRequirement[], ApplicationMigrationPlanError> {
    const decoded = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        inventory: Schema.Array(ApplicationMigrationOwnerInventorySchema),
        requirements: ApplicationMigrationRequirementsSchema,
      }),
      { onExcessProperty: 'error' },
    )({ inventory, requirements }).pipe(
      Effect.mapError(() => invalid('Migration requirements need complete typed source inventory')),
    );
    const byOwner = yield* validateInventory(decoded.inventory);
    const roots = decoded.requirements.owners;
    if (
      !unique(roots.map((root) => root.ownerId)) ||
      roots.some((root) => !validRequirement(root) || !byOwner.has(root.ownerId)) ||
      (decoded.requirements.mode === 'none' && roots.length > 0) ||
      (decoded.requirements.mode === 'selected' && roots.length === 0)
    ) {
      return yield* invalid('Migration selection has an unknown, duplicate or contradictory requirement');
    }
    const selected = new Map<string, ApplicationMigrationRequirement>();
    const ordered: string[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (requirement: ApplicationMigrationRequirement): Effect.Effect<void, ApplicationMigrationPlanError> =>
      Effect.gen(function* visitRequirement() {
        const owner = byOwner.get(requirement.ownerId);
        if (owner === undefined || visiting.has(requirement.ownerId)) {
          return yield* invalid(`Unknown or cyclic migration prerequisite ${requirement.ownerId}`);
        }
        if (
          requirement.throughMigration !== undefined &&
          !owner.migrations.some((entry) => entry.name === requirement.throughMigration)
        ) {
          return yield* invalid(`Unknown required migration for ${requirement.ownerId}`);
        }
        const existing = selected.get(requirement.ownerId);
        if (
          existing?.migrate === true &&
          requirement.migrate &&
          (existing.throughMigration ?? owner.migrations.at(-1)?.name) !==
            (requirement.throughMigration ?? owner.migrations.at(-1)?.name)
        ) {
          return yield* invalid(`Conflicting reviewed migration targets for ${requirement.ownerId}`);
        }
        selected.set(requirement.ownerId, mergeRequirement(existing, requirement));
        if (visited.has(requirement.ownerId)) {
          return yield* Effect.void;
        }
        visiting.add(requirement.ownerId);
        for (const prerequisite of owner.prerequisites) {
          yield* visit(prerequisite);
        }
        visiting.delete(requirement.ownerId);
        visited.add(requirement.ownerId);
        ordered.push(requirement.ownerId);
        return yield* Effect.void;
      });
    const rootRequirements =
      decoded.requirements.mode === 'all'
        ? [
            ...decoded.inventory
              .filter((owner) => !owner.optional && !roots.some((root) => root.ownerId === owner.ownerId))
              .map((owner) => ({ migrate: true, ownerId: owner.ownerId, verify: true })),
            ...roots,
          ]
        : roots;
    // Inventory order is the existing reviewed runner order; request order never changes execution order.
    for (const owner of decoded.inventory) {
      for (const root of rootRequirements.filter((requirement) => requirement.ownerId === owner.ownerId)) {
        yield* visit(root);
      }
    }
    const resolved: ApplicationMigrationRequirement[] = [];
    for (const identifier of ordered) {
      const requirement = selected.get(identifier);
      if (requirement === undefined) {
        return yield* invalid(`Missing resolved migration requirement for ${identifier}`);
      }
      resolved.push(requirement);
    }
    return resolved;
  },
);

/** Deterministic prerequisite closure. Build selection and complete runtime membership are intentionally absent. */
export const selectApplicationMigrationPlan = Effect.fn('ApplicationMigrationPlan.select')(
  function* selectApplicationMigrationPlanEffect(
    requirements: ApplicationMigrationRequirements,
    inventory: readonly ApplicationMigrationOwnerInventory[],
    observations: readonly ApplicationMigrationObservation[],
  ): Effect.fn.Return<ApplicationMigrationPlan, ApplicationMigrationPlanError> {
    const resolved = yield* resolveApplicationMigrationRequirements(requirements, inventory);
    const decodedObservations = yield* Schema.decodeUnknownEffect(Schema.Array(ApplicationMigrationObservationSchema), {
      onExcessProperty: 'error',
    })(observations).pipe(
      Effect.mapError(() => invalid('Migration selection requires complete typed native evidence')),
    );
    const byOwner = new Map(inventory.map((owner) => [owner.ownerId, owner]));
    if (
      !unique(decodedObservations.map((observation) => observation.ownerId)) ||
      decodedObservations.some((observation) => !byOwner.has(observation.ownerId))
    ) {
      return yield* invalid('Migration selection has unknown or duplicate observations');
    }
    const observed = new Map(decodedObservations.map((observation) => [observation.ownerId, observation]));
    const owners: ApplicationMigrationPlan['owners'][number][] = [];
    for (const requirement of resolved) {
      const owner = byOwner.get(requirement.ownerId);
      const before = observed.get(requirement.ownerId);
      if (owner === undefined || before === undefined) {
        return yield* invalid(`Missing native schema and journal observation for ${requirement.ownerId}`);
      }
      owners.push(yield* planOwner(owner, requirement, before));
    }
    return {
      initializationOwners: resolved.map((requirement) => requirement.ownerId),
      mode: requirements.mode,
      owners,
      schemaVersion: 1,
    };
  },
);
