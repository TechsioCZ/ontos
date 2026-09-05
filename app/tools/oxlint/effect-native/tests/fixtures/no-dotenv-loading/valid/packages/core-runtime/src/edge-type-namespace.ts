// `import type * as ...` is fully erased even under verbatimModuleSyntax: nothing is loaded.
import type * as Dotenv from 'dotenv';

export const describe = (result: Dotenv.DotenvConfigOutput): string => String(result.parsed);
