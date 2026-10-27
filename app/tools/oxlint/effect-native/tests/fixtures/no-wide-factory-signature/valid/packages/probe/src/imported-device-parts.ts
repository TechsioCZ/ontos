import { PrincipalRefSchema } from '@app/core-runtime/permissions/principal-ref';
import { Schema as S } from 'effect';

export const resourceId = (brand: string) => S.String.pipe(S.brand(brand));
export const text = (maximum: number) => S.Trim.check(S.isMaxLength(maximum));
export const AuditSchema = S.Struct({
  createdAt: S.DateTimeUtcFromString,
  createdBy: PrincipalRefSchema,
});
