function inject(): ClassDecorator {
  return () => undefined;
}

@inject()
export class Service {
  #key = 'k';
  importJWK(value: string): string {
    return this.#key + value;
  }
  run(): string {
    return this.importJWK('x');
  }
}
