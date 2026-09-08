// expect-count: 5
declare const registry: { readonly kind: 'create' | 'update' };

function traced<T extends abstract new (...args: never[]) => unknown>(target: T): T {
  return target;
}

@traced
export class BaseClassifier {
  protected readonly _tag: 'A' | 'B' = 'A';
  #phase: 'idle' | 'busy' = 'idle';
  accessor mode: 'compact' | 'full' = 'compact';

  /** `this._tag` is the same tagged-union classifier. */
  describe(): string {
    switch (this._tag) {
      case 'A': {
        return 'a';
      }
      case 'B': {
        return 'b';
      }
    }
  }

  /** A private field hides the property name but not the closed vocabulary. */
  get phase(): string {
    switch (this.#phase) {
      case 'idle': {
        return 'idle';
      }
      case 'busy': {
        return 'busy';
      }
    }
  }

  /** An `accessor` field is still a hand-rolled vocabulary. */
  render(): string {
    switch (this.mode) {
      case 'compact': {
        return 'c';
      }
      case 'full': {
        return 'f';
      }
    }
  }

  /** Static methods are not a hiding place either. */
  static classify(): string {
    switch (registry.kind) {
      case 'create': {
        return 'c';
      }
      case 'update': {
        return 'u';
      }
    }
  }
}

export class SubClassifier extends BaseClassifier {
  override describe(): string {
    switch (super._tag) {
      case 'A': {
        return 'a';
      }
      case 'B': {
        return 'b';
      }
    }
  }
}
