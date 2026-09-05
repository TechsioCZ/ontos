// `Schema` from a local module is not Effect's Schema.
import { Schema } from './local-schema.ts';

export const decodeLocal = (value: unknown): string => Schema.decodeUnknownSync(value);
export const validateLocal = (value: unknown): string => Schema.validateSync(value);
