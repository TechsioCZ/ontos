// False-positive probe: computed member access on the Schema namespace. The rule already resolves a
// computed *collection* method (`rows["filter"](guard)` is exempt via `staticPropertyName`), so the
// same access form on the authority side should resolve too — the body is one delegating call.
import { Schema } from 'effect';

export const TenantSchema = Schema.Struct({ tenantId: Schema.String });
export type Tenant = typeof TenantSchema.Type;

export const isTenant = (value: unknown): value is Tenant => Schema['is'](TenantSchema)(value);
