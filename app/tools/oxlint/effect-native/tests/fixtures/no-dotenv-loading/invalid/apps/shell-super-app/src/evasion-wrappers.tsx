// TSX + every callee wrapper a rule has to see through: `as`, `satisfies`, `!`, parentheses,
// optional chaining, computed members, class members, async generators and nested arrows.
import dotenv from 'dotenv';
import { config as loadDotenv, parse as parseEnv } from 'dotenv-flow';

type Loader = (options: { readonly path: string }) => void;

export class EnvironmentGate {
  static {
    (loadDotenv as Loader)({ path: '.env' });
  }

  readonly parsed = (parseEnv satisfies typeof parseEnv)('A=1');

  reload(): void {
    dotenv!.config({ quiet: true });
  }
}

export async function* streamEnvironment(): AsyncGenerator<string> {
  const again = () => dotenv?.['config']({ quiet: true });
  again();
  yield String(process.env['DATABASE_URL']);
}

export const Panel = () => <section>{String((dotenv.config)({ quiet: true }).parsed)}</section>;
