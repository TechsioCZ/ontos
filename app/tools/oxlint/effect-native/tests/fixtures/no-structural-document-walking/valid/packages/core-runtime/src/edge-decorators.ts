function inject(): ClassDecorator {
  return () => undefined;
}

@inject()
export class Decorated {
  accessor label = 'shell';

  render(items: readonly string[]): readonly string[] {
    return Array.isArray(items) ? items : [];
  }
}
