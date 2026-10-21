// Wire shapes the tools read, as Effect Schemas. Each schema names the vertical file it mirrors.
// Only the fields a tool reads are declared; the vertical owns validation of everything else.
// Money fields are integer CZK minor units unless the name ends in Czk.
import { Schema } from 'effect';

/** Any answer that carries the current revision of a vertical's aggregate. */
export const RevisionWire = Schema.Struct({ revision: Schema.Number });

/** workforce/shared/apis/records.ts EmployeeSchema */
export const EmployeeWire = Schema.Struct({
  active: Schema.Boolean,
  department: Schema.String,
  email: Schema.String,
  fullName: Schema.String,
  id: Schema.String,
  phone: Schema.optionalKey(Schema.String),
  role: Schema.String,
});

export const EmployeesWire = Schema.Struct({ items: Schema.Array(EmployeeWire) });

/** tagging/shared/apis/records.ts TagWithCountsSchema */
export const TagWire = Schema.Struct({
  color: Schema.String,
  counts: Schema.Record(Schema.String, Schema.Number),
  description: Schema.optionalKey(Schema.String),
  id: Schema.String,
  name: Schema.String,
  subjectKinds: Schema.Array(Schema.String),
});

/** tagging/shared/apis/records.ts AssignmentSchema */
export const AssignmentWire = Schema.Struct({
  subject: Schema.Struct({ id: Schema.String, kind: Schema.String }),
  tagId: Schema.String,
});

/** tagging/shared/apis/records.ts RecordsResponseSchema */
export const TaggingRecordsWire = Schema.Struct({
  assignments: Schema.Array(AssignmentWire),
  revision: Schema.Number,
  tags: Schema.Array(TagWire),
});

/** party-registry/shared/apis/customer-list.ts CustomerListItemSchema (nullable Option fields are null on the wire) */
export const CustomerWire = Schema.Struct({
  city: Schema.NullOr(Schema.String),
  companyId: Schema.NullOr(Schema.String),
  displayName: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
  partyId: Schema.String,
  phone: Schema.NullOr(Schema.String),
  status: Schema.String,
  vatId: Schema.NullOr(Schema.String),
});

export const CustomerListWire = Schema.Struct({ items: Schema.Array(CustomerWire) });

/** sales-pipeline/shared/model/opportunity.ts OpportunitySchema */
export const OpportunityWire = Schema.Struct({
  amountMinor: Schema.Number,
  expectedCloseDate: Schema.String,
  id: Schema.String,
  ownerEmployeeId: Schema.optionalKey(Schema.String),
  partyId: Schema.String,
  probability: Schema.Number,
  stage: Schema.String,
  title: Schema.String,
});

/** sales-pipeline/shared/apis/records.ts OpportunityIndicatorsSchema; winRate is a 0..1 fraction or null */
export const OpportunityIndicatorsWire = Schema.Struct({
  lostCount: Schema.Number,
  openCount: Schema.Number,
  openValueMinor: Schema.Number,
  weightedValueMinor: Schema.Number,
  winRate: Schema.NullOr(Schema.Number),
  wonCount: Schema.Number,
  wonValueMinor: Schema.Number,
});

export const OpportunitiesRecordsWire = Schema.Struct({
  indicators: OpportunityIndicatorsWire,
  items: Schema.Array(OpportunityWire),
  revision: Schema.Number,
});

export const OpportunityCommandResultWire = Schema.Struct({
  opportunities: Schema.Array(OpportunityWire),
  revision: Schema.Number,
});

/** merchandise/domain/merchandise-model.ts ProductRecordSchema */
export const ProductWire = Schema.Struct({
  active: Schema.Boolean,
  category: Schema.String,
  currentPriceMinor: Schema.Number,
  id: Schema.String,
  lowStock: Schema.Boolean,
  lowStockThreshold: Schema.Number,
  name: Schema.String,
  sku: Schema.String,
  stockOnHand: Schema.Number,
  stockValueMinor: Schema.Number,
  unit: Schema.String,
  vatRate: Schema.Number,
});

/** merchandise/domain/merchandise-model.ts StockMovementSchema */
export const MovementWire = Schema.Struct({
  delta: Schema.Number,
  productId: Schema.String,
});

/** merchandise/domain/merchandise-model.ts OrderSchema */
export const OrderWire = Schema.Struct({
  createdAt: Schema.String,
  id: Schema.String,
  lines: Schema.Array(
    Schema.Struct({
      productId: Schema.String,
      productName: Schema.String,
      quantity: Schema.Number,
      unitPriceMinor: Schema.Number,
      vatRate: Schema.Number,
    }),
  ),
  number: Schema.String,
  opportunityId: Schema.optionalKey(Schema.String),
  partyId: Schema.String,
  status: Schema.String,
  totalMinor: Schema.Number,
  totalVatMinor: Schema.Number,
});

export const MerchandiseRecordsWire = Schema.Struct({
  indicators: Schema.Struct({
    lowStockCount: Schema.Number,
    openOrderValueMinor: Schema.Number,
    orderCount: Schema.Number,
    productCount: Schema.Number,
    stockValueMinor: Schema.Number,
  }),
  movements: Schema.Array(MovementWire),
  orders: Schema.Array(OrderWire),
  products: Schema.Array(ProductWire),
  revision: Schema.Number,
});

/** finance-billing/shared/apis/records.ts InvoiceSchema (subset) */
export const InvoiceWire = Schema.Struct({
  businessState: Schema.String,
  counterpartyRef: Schema.Struct({ resourceId: Schema.String }),
  direction: Schema.String,
  documentNumber: Schema.String,
  dueDate: Schema.String,
  issueDate: Schema.String,
  number: Schema.optionalKey(Schema.String),
  opportunityId: Schema.optionalKey(Schema.String),
  paidMinor: Schema.Number,
  partyId: Schema.optionalKey(Schema.String),
  paymentState: Schema.String,
  totalMinor: Schema.Number,
});

export const BillingStateWire = Schema.Struct({ invoices: Schema.Array(InvoiceWire) });

export const BillingRecordsWire = Schema.Struct({
  canWrite: Schema.Boolean,
  indicators: Schema.Record(Schema.String, Schema.Number),
  referenceDate: Schema.String,
  revision: Schema.Number,
  state: BillingStateWire,
});

/** work-tasks/shared/apis/records.ts TaskSchema (subset) */
export const TaskWire = Schema.Struct({
  assigneeEmployeeId: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  dueDate: Schema.optionalKey(Schema.String),
  opportunityId: Schema.optionalKey(Schema.String),
  partyId: Schema.optionalKey(Schema.String),
  priority: Schema.String,
  // The whole reference goes back to the vertical as the task's identity on updates.
  ref: Schema.Struct({
    moduleId: Schema.String,
    resourceId: Schema.String,
    resourceType: Schema.String,
    tenantId: Schema.String,
  }),
  state: Schema.String,
  title: Schema.String,
});

export const WorkRecordsWire = Schema.Struct({
  indicators: Schema.Struct({ open: Schema.Number, overdue: Schema.Number }),
  items: Schema.Array(TaskWire),
  referenceDate: Schema.String,
  revision: Schema.Number,
});

export const WorkCommandResultWire = Schema.Struct({
  revision: Schema.Number,
  task: Schema.optionalKey(TaskWire),
});

export const TaggingCommandResultWire = Schema.Struct({
  affectedAssignments: Schema.Number,
  revision: Schema.Number,
  tagId: Schema.String,
});
