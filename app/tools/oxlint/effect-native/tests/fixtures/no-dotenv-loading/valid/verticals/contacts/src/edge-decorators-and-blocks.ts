// Decorators, class fields, static blocks, async generators and labelled statements: parse probe with
// no dotenv anywhere. Type-only dotenv usage is erased by `import type`.
import type { DotenvConfigOutput } from 'dotenv';

const Injectable = (): ClassDecoratorFunction => (target) => target;
type ClassDecoratorFunction = <T extends abstract new (...args: never[]) => unknown>(target: T) => T;

@Injectable()
export class ContactsRegistry {
  static #instances = 0;
  accessor label = 'contacts';

  static {
    ContactsRegistry.#instances += 1;
  }

  async *entries(): AsyncGenerator<number> {
    outer: for (let index = 0; index < 2; index += 1) {
      if (index === 1) break outer;
      yield index;
    }
  }
}

export const describe = (result: DotenvConfigOutput): string => String(result.parsed);
