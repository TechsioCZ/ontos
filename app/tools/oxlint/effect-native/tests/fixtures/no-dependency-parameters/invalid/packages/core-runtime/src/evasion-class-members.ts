// expect-count: 8
import { Effect } from "effect";

interface ContactsGateway {
  readonly list: () => Effect.Effect<string>;
}
declare const CoreDatabase: { readonly Service: { readonly query: () => Effect.Effect<string> } };

export class Runtime {
  // 1: TypeScript parameter property.
  constructor(private readonly gateway: ContactsGateway) {}
  // 2: static factory.
  static build(database: (typeof CoreDatabase)["Service"]) {
    return database;
  }
  // 3: instance method.
  run(gateway: ContactsGateway) {
    return gateway;
  }
  // 4: setter.
  set dependency(value: ContactsGateway) {
    this.current = value;
  }
  current: ContactsGateway | undefined;
  // 5: class field holding an arrow.
  readonly bind = (gateway: ContactsGateway) => gateway;
}

export abstract class AbstractRuntime {
  // 6: abstract method signature.
  abstract install(gateway: ContactsGateway): void;
}

export const registry = {
  // 7: object literal method.
  install(gateway: ContactsGateway) {
    return gateway;
  },
  // 8: object literal function expression.
  bind: function (gateway: ContactsGateway) {
    return gateway;
  },
};
