// expect-count: 2
import * as Bff from '@modern-js/plugin-bff/effect-client';

// 1 — the BFF barrel imported as a namespace: `Bff.Schema.Struct`.
export const RowSchema = Bff.Schema.Struct({
  tenantId: Bff.Schema.String,
  label: Bff.Schema.String,
});

// 2 — shared identifier schema through the same barrel.
export const PrincipalIdSchema = Bff.Schema.String.check(Bff.Schema.isUUID());
