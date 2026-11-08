import { DateTime, Effect, Schema } from 'effect';

/**
 * Synthetic sales-demo fixture data, not a business classification or a deployment contract.
 *
 * Side-effect free: the browser segment client and the local operator demo seed both read it.
 * `create-customer-group` reuses an existing group when business code, meaning key, purpose and
 * membership criteria are identical, so these definitions double as the lookup key for the group.
 * Never edit purpose or membership criteria of a seeded segment; a changed fingerprint is a new group.
 */
export interface CustomerSegmentDefinition {
  readonly businessCode: string;
  readonly description: string;
  readonly meaningKey: string;
  readonly membershipCriteria: string;
  readonly name: string;
  readonly purpose: string;
}

export const customerSegmentDefinitions = [
  {
    businessCode: 'SALES_DEMO_KEY_ACCOUNTS',
    description: 'Strategičtí odběratelé s vyhrazeným obchodníkem a individuálními podmínkami.',
    meaningKey: 'sales-demo.segment.key-accounts',
    membershipCriteria: 'Roční obrat nad 5 mil. Kč nebo platná rámcová smlouva.',
    name: 'Klíčoví zákazníci',
    purpose: 'Prioritní obchodní péče o strategické odběratele.',
  },
  {
    businessCode: 'SALES_DEMO_B2B_STANDARD',
    description: 'Firemní odběratelé se standardním ceníkem a splatností.',
    meaningKey: 'sales-demo.segment.b2b-standard',
    membershipCriteria: 'Firemní zákazník s IČO bez individuální rámcové smlouvy.',
    name: 'B2B standard',
    purpose: 'Standardní obchodní podmínky pro firemní odběratele.',
  },
  {
    businessCode: 'SALES_DEMO_RETAIL',
    description: 'Prodejny a řetězce, které nakupují zboží k dalšímu prodeji spotřebitelům.',
    meaningKey: 'sales-demo.segment.retail',
    membershipCriteria: 'Zákazník provozuje kamennou nebo online prodejnu pro spotřebitele.',
    name: 'Maloobchod',
    purpose: 'Obchodní péče o maloobchodní a spotřebitelský prodej.',
  },
  {
    businessCode: 'SALES_DEMO_PUBLIC_SECTOR',
    description: 'Veřejní zadavatelé a organizace s veřejnou zakázkou nebo dotačním financováním.',
    meaningKey: 'sales-demo.segment.public-sector',
    membershipCriteria: 'Veřejný zadavatel nebo dodávka financovaná z veřejných prostředků.',
    name: 'Veřejný sektor',
    purpose: 'Obchod s veřejnými zadavateli podle pravidel zadávání veřejných zakázek.',
  },
] as const satisfies readonly CustomerSegmentDefinition[];

export type CustomerSegmentCode = (typeof customerSegmentDefinitions)[number]['businessCode'];

const uuid = Schema.String.check(Schema.isUUID());
const instant = Schema.DateTimeUtcFromString;
const counterpartyIdSchema = uuid.pipe(Schema.brand('SalesDemoCounterpartyId'));
const partyIdSchema = uuid.pipe(Schema.brand('SalesDemoPartyId'));
const rolePeriodIdSchema = uuid.pipe(Schema.brand('SalesDemoRolePeriodId'));
const membershipInvocationIdSchema = uuid.pipe(Schema.brand('SalesDemoMembershipInvocationId'));
const profileInvocationIdSchema = uuid.pipe(Schema.brand('SalesDemoProfileInvocationId'));
const actorPrincipalIdSchema = uuid.pipe(Schema.brand('SalesDemoActorPrincipalId'));
const invocationIdSchema = uuid.pipe(Schema.brand('SalesDemoInvocationId'));
const legalEntityIdSchema = uuid.pipe(Schema.brand('SalesDemoLegalEntityId'));
const runIdSchema = uuid.pipe(Schema.brand('SalesDemoRunId'));
const tenantIdSchema = uuid.pipe(Schema.brand('SalesDemoTenantId'));
const icoSchema = Schema.String.check(Schema.isPattern(/^\d{8}$/u)).pipe(Schema.brand('SalesDemoIco'));

const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const segmentCode = Schema.Literals(customerSegmentDefinitions.map(({ businessCode }) => businessCode));

/** Explicit input to the two local owner seeds. These are synthetic fixture facts, never live authority. */
export const SalesDemoCustomerFixtureSchema = Schema.Struct({
  city: text,
  counterpartyId: counterpartyIdSchema,
  domain: text,
  ico: icoSchema,
  mailbox: text,
  membershipInvocationId: membershipInvocationIdSchema,
  name: text,
  partyId: partyIdSchema,
  phone: text,
  postalCode: text,
  profileInvocationId: profileInvocationIdSchema,
  segmentCode,
  street: text,
});
export type SalesDemoCustomerFixture = typeof SalesDemoCustomerFixtureSchema.Type;

export const SalesDemoSeedInputSchema = Schema.Struct({
  actorPrincipalId: actorPrincipalIdSchema,
  customers: Schema.Array(SalesDemoCustomerFixtureSchema).check(Schema.isBetweenLength(40, 40)),
  expiresAt: instant,
  format: Schema.Literal('sales-demo-customers/1'),
  groups: Schema.Array(Schema.Struct({ businessCode: segmentCode, invocationId: invocationIdSchema })).check(
    Schema.isBetweenLength(4, 4),
  ),
  issuedAt: instant,
  legalEntityId: legalEntityIdSchema,
  namespace: uuid,
  runId: runIdSchema,
  tenantId: tenantIdSchema,
});
export type SalesDemoSeedInput = typeof SalesDemoSeedInputSchema.Type;

/** Only the owner can populate this from its committed, current CUSTOMER role rows. */
export const SalesDemoCustomerRolesSchema = Schema.Struct({
  customers: Schema.Array(
    Schema.Struct({
      counterpartyId: counterpartyIdSchema,
      ico: icoSchema,
      partyId: partyIdSchema,
      rolePeriodId: rolePeriodIdSchema,
      roleRecordedAt: instant,
    }),
  ).check(Schema.isBetweenLength(40, 40)),
  expiresAt: instant,
  format: Schema.Literal('sales-demo-customer-roles/1'),
  legalEntityId: legalEntityIdSchema,
  observedAt: instant,
  runId: runIdSchema,
  tenantId: tenantIdSchema,
});
export type SalesDemoCustomerRoles = typeof SalesDemoCustomerRolesSchema.Type;

export class SalesDemoFixtureInvalid extends Schema.TaggedError<SalesDemoFixtureInvalid>()('SalesDemoFixtureInvalid', {
  cause: Schema.optionalKey(Schema.Defect()),
  reason: Schema.String,
}) {}
const invalid = (cause?: unknown) =>
  new SalesDemoFixtureInvalid({
    cause,
    reason: 'The explicit sales-demo fixture or committed role handoff is invalid',
  });
const milliseconds = DateTime.toEpochMillis;

export const decodeSalesDemoSeedInput = Schema.decodeUnknownEffect(SalesDemoSeedInputSchema, {
  onExcessProperty: 'error',
});
export const decodeSalesDemoCustomerRoles = Schema.decodeUnknownEffect(SalesDemoCustomerRolesSchema, {
  onExcessProperty: 'error',
});

export const validateSalesDemoSeedInput = Effect.fn('SalesDemoFixture.validateInput')(function* validateInput(
  input: SalesDemoSeedInput,
  now: DateTime.Utc,
) {
  const observed = DateTime.toEpochMillis(now);
  const issued = milliseconds(input.issuedAt);
  const expires = milliseconds(input.expiresAt);
  if (
    issued > observed ||
    expires <= observed ||
    expires <= issued ||
    expires - issued > 15 * 60_000 ||
    new Set(input.customers.map(({ ico }) => ico)).size !== input.customers.length ||
    new Set(input.customers.map(({ partyId }) => partyId)).size !== input.customers.length ||
    new Set(input.customers.map(({ counterpartyId }) => counterpartyId)).size !== input.customers.length ||
    new Set(input.groups.map(({ businessCode }) => businessCode)).size !== customerSegmentDefinitions.length
  ) {
    return yield* invalid();
  }
  return input;
});

export const validateSalesDemoCustomerRoles = Effect.fn('SalesDemoFixture.validateCommittedRoles')(
  function* validateRoles(input: SalesDemoSeedInput, roles: SalesDemoCustomerRoles, now: DateTime.Utc) {
    yield* validateSalesDemoSeedInput(input, now);
    const observed = milliseconds(roles.observedAt);
    if (
      roles.runId !== input.runId ||
      roles.tenantId !== input.tenantId ||
      roles.legalEntityId !== input.legalEntityId ||
      milliseconds(roles.expiresAt) !== milliseconds(input.expiresAt) ||
      observed < milliseconds(input.issuedAt) ||
      observed > DateTime.toEpochMillis(now) ||
      new Set(roles.customers.map(({ counterpartyId }) => counterpartyId)).size !== input.customers.length ||
      new Set(roles.customers.map(({ rolePeriodId }) => rolePeriodId)).size !== input.customers.length
    ) {
      return yield* invalid();
    }
    for (const customer of input.customers) {
      const role = roles.customers.find(({ counterpartyId }) => counterpartyId === customer.counterpartyId);
      if (
        role === undefined ||
        role.ico !== customer.ico ||
        role.partyId !== customer.partyId ||
        milliseconds(role.roleRecordedAt) > observed
      ) {
        return yield* invalid();
      }
    }
    return roles;
  },
);
