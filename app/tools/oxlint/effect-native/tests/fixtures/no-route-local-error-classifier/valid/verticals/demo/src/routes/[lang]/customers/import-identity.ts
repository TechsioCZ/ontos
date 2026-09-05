// Import identity is resolved through the declaration, not the printed name: this local alias only
// *looks* like the erased-union projection type, so it must not report.
import type { PagingInput as ErrorClassificationInput } from '../../../paging.ts';

type Row = { readonly id: string };

export const pageOf = (input: ErrorClassificationInput<Row>) => input;

// Namespace import of an unrelated module: `Formatting.ErrorClassificationInput` is not the type.
import * as Formatting from '../../../formatting.ts';

export const describe = (value: Formatting.Describable) => String(value);
