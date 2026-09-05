import { Schema } from 'effect';

const decorate = (target: unknown): unknown => target;

export const TenantIdSchema = Schema.String.pipe(Schema.brand('TenantId'));

@decorate
class Row {
  static readonly schema = Schema.Struct({ tenantId: TenantIdSchema });
}

export { Row };
