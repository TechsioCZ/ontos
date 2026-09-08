import { Schema } from 'effect';

function Tagged(target: unknown, context: ClassDecoratorContext): void {
  void target;
  void context;
}

@Tagged
class Registry {
  static readonly schema = Schema.Struct({ registeredAt: Schema.DateTimeUtc });

  #createdAt = new Date();

  get createdAt(): Date {
    return this.#createdAt;
  }
}

export { Registry };
