// Parse/crash probe: decorators, private fields, async generators, `satisfies`, optional chaining
// and computed members with no cookie construction anywhere.
declare const Injectable: (...args: readonly unknown[]) => ClassDecorator;
declare const Field: () => PropertyDecorator;

@Injectable()
export class SessionReader {
  @Field() readonly names: readonly string[] = [];
  #cache = new Map<string, string>();

  async *read(headers?: Headers): AsyncGenerator<string> {
    const raw = headers?.get?.('cookie') ?? '';
    yield raw satisfies string;
    for (const name of this.names) yield this.#cache.get(name) ?? '';
  }
}
