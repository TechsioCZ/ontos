// `Schema` here is a local helper, not Effect's Schema namespace.
import { Schema } from './local-schema.ts';

export const first = Schema.Literals(['alpha', 'beta']);
export const second = Schema.Literals(['alpha', 'beta']);
export const third = Schema.Literals(['beta', 'alpha']);
