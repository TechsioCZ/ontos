// A3 evasion: an inline `type` modifier is NOT `import type`. Under this repo's
// tsconfig.base.json `"verbatimModuleSyntax": true`, TypeScript emits the statement verbatim minus the
// type specifiers, i.e. `import {} from "dotenv"` — a side-effect import that runs dotenv and mutates
// ambient process.env exactly like `import "dotenv/config"`.
import { type DotenvConfigOutput } from 'dotenv';

export const describeResult = (result: DotenvConfigOutput): string => String(result.error);
