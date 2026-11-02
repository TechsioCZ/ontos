import { Array as EffectArray, Match, Order } from 'effect';
import { parseSync, Visitor } from 'oxc-parser';
import type {
  ArrowFunctionExpression,
  BindingPattern,
  CallExpression,
  Class as AstClass,
  MemberExpression,
  Expression,
  Function as AstFunction,
  ParamPattern,
  Program,
  Span,
  TSInterfaceDeclaration,
  TSFunctionType,
  TSTypeAnnotation,
  TSTypeParameter,
  TSTypeLiteral,
} from 'oxc-parser';

export type PreparationFunction = ArrowFunctionExpression | AstFunction;

const coreRuntimeModule = '@app/core-runtime';

const contains = (outer: Span, inner: Span): boolean => outer.start <= inner.start && inner.end <= outer.end;

interface Binding {
  readonly annotation?: TSTypeAnnotation | null;
  readonly declaration: Span;
  readonly implementation?: PreparationFunction;
  readonly imported?: { readonly name: string; readonly source: string; readonly typeOnly: boolean };
  readonly init?: Expression;
  readonly name: string;
  readonly projection?: number;
  readonly scope: Span;
  readonly stable: boolean;
}

const patternNames = (pattern: BindingPattern | ParamPattern): readonly string[] =>
  Match.value(pattern).pipe(
    Match.when({ type: 'Identifier' }, (node) => [node.name]),
    Match.when({ type: 'AssignmentPattern' }, (node) => patternNames(node.left)),
    Match.when({ type: 'ObjectPattern' }, (node) =>
      node.properties.flatMap((property) =>
        patternNames(property.type === 'RestElement' ? property.argument : property.value),
      ),
    ),
    Match.when({ type: 'ArrayPattern' }, (node) =>
      node.elements.flatMap((element) =>
        element === null ? [] : patternNames(element.type === 'RestElement' ? element.argument : element),
      ),
    ),
    Match.when({ type: 'RestElement' }, (node) => patternNames(node.argument)),
    Match.when({ type: 'TSParameterProperty' }, (node) => patternNames(node.parameter)),
    Match.exhaustive,
  );

/** Conservative lexical binding evidence. A write anywhere invalidates a binding for this analysis. */
export class PreparationSource {
  readonly program: Program;
  readonly functions: PreparationFunction[] = [];
  readonly calls: CallExpression[] = [];
  readonly bindings: Binding[] = [];
  readonly writes = new Set<Binding>();
  readonly factories = new Set<number>();
  readonly preflights = new Set<number>();
  readonly readFinishes = new Set<number>();
  readonly contextIndexes = new Map<number, readonly number[]>();
  readonly privateConsumers = new Set<number>();
  readonly callbackInputs: Span[] = [];
  readonly safeCalls = new Set<number>();
  readonly executorEscapes = new Map<PreparationFunction, Map<string, boolean>>();
  resolveCallable?: (expression: Expression) => ResolvedPreparation | undefined;

  constructor(file: string, source: string) {
    const parsed = parseSync(file, source, { astType: 'ts', lang: file.endsWith('.tsx') ? 'tsx' : 'ts' });
    this.program = parsed.program;
    if (parsed.errors.length > 0) {
      return;
    }
    const scopes: Span[] = [this.program];
    const scope = (): Span => scopes.at(-1) ?? this.program;
    const addPattern = (pattern: BindingPattern | ParamPattern, owner: Span): void => {
      for (const name of patternNames(pattern)) {
        this.bindings.push({ declaration: pattern, name, scope: owner, stable: false });
      }
    };
    const addTypeParameters = (owner: Span, parameters: readonly TSTypeParameter[]): void => {
      for (const parameter of parameters) {
        this.bindings.push({ declaration: parameter, name: parameter.name.name, scope: owner, stable: false });
      }
    };
    const enterFunction = (node: PreparationFunction): void => {
      if (node.type === 'FunctionDeclaration' && node.id !== null) {
        this.bindings.push({
          declaration: node.id,
          implementation: node,
          name: node.id.name,
          scope: scope(),
          stable: true,
        });
      }
      this.functions.push(node);
      scopes.push(node);
      if (node.type === 'FunctionExpression' && node.id !== null) {
        this.bindings.push({
          declaration: node.id,
          implementation: node,
          name: node.id.name,
          scope: node,
          stable: true,
        });
      }
      for (const parameter of node.params) {
        addPattern(parameter, node);
      }
      addTypeParameters(node, node.typeParameters?.params ?? []);
    };
    const leaveScope = (): void => {
      scopes.pop();
    };
    new Visitor({
      ArrowFunctionExpression: enterFunction,
      'ArrowFunctionExpression:exit': leaveScope,
      BlockStatement: (node) => {
        scopes.push(node);
      },
      'BlockStatement:exit': leaveScope,
      CallExpression: (node) => {
        this.calls.push(node);
      },
      CatchClause: (node) => {
        if (node.param !== null) {
          addPattern(node.param, node.body);
        }
      },
      ClassDeclaration: (node) => {
        addTypeParameters(node, node.typeParameters?.params ?? []);
        if (node.id !== null) {
          this.bindings.push({ declaration: node.id, name: node.id.name, scope: scope(), stable: false });
        }
      },
      FunctionDeclaration: enterFunction,
      'FunctionDeclaration:exit': leaveScope,
      FunctionExpression: enterFunction,
      'FunctionExpression:exit': leaveScope,
      ImportDeclaration: (node) => {
        for (const specifier of node.specifiers) {
          this.bindings.push({
            declaration: specifier.local,
            imported: {
              name:
                specifier.type === 'ImportSpecifier' && specifier.imported.type === 'Identifier'
                  ? specifier.imported.name
                  : '',
              source: node.source.value,
              typeOnly:
                node.importKind === 'type' || (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type'),
            },
            name: specifier.local.name,
            scope: this.program,
            stable: true,
          });
        }
      },
      TSInterfaceDeclaration: (node) => {
        addTypeParameters(node, node.typeParameters?.params ?? []);
        this.bindings.push({ declaration: node.id, name: node.id.name, scope: scope(), stable: false });
      },
      TSTypeAliasDeclaration: (node) => {
        addTypeParameters(node, node.typeParameters?.params ?? []);
        this.bindings.push({ declaration: node.id, name: node.id.name, scope: scope(), stable: false });
      },
      VariableDeclaration: (node) => {
        const owner =
          node.kind === 'var'
            ? (EffectArray.reverse(scopes).find(
                (candidate) =>
                  candidate === this.program || this.functions.some((implementation) => implementation === candidate),
              ) ?? this.program)
            : scope();
        for (const declaration of node.declarations) {
          if (declaration.id.type === 'Identifier') {
            this.bindings.push({
              annotation: declaration.id.typeAnnotation,
              declaration: declaration.id,
              init: declaration.init ?? undefined,
              name: declaration.id.name,
              scope: owner,
              stable: node.kind === 'const',
            });
          } else if (declaration.id.type === 'ArrayPattern') {
            for (const [index, element] of declaration.id.elements.entries()) {
              if (element?.type === 'Identifier') {
                this.bindings.push({
                  declaration: element,
                  init: declaration.init ?? undefined,
                  name: element.name,
                  projection: index,
                  scope: owner,
                  stable: node.kind === 'const',
                });
              } else if (element !== null) {
                addPattern(element.type === 'RestElement' ? element.argument : element, owner);
              }
            }
          } else {
            addPattern(declaration.id, owner);
          }
        }
      },
    }).visit(this.program);
    const writeTargets: Span[] = [];
    new Visitor({
      AssignmentExpression: (node) => {
        writeTargets.push(node.left);
      },
      UnaryExpression: (node) => {
        if (node.operator === 'delete') {
          writeTargets.push(node.argument);
        }
      },
      UpdateExpression: (node) => {
        writeTargets.push(node.argument);
      },
    }).visit(this.program);
    new Visitor({
      Identifier: (identifier) => {
        if (writeTargets.some((target) => contains(target, identifier))) {
          const binding = this.resolve(identifier.name, identifier);
          if (binding !== undefined) {
            this.writes.add(binding);
          }
        }
      },
    }).visit(this.program);
    for (const binding of this.writes) {
      if (binding.init?.type === 'Identifier') {
        const target = this.resolve(binding.init.name, binding.init);
        if (target !== undefined) {
          this.writes.add(target);
        }
      }
    }
  }

  resolve(name: string, at: Span): Binding | undefined {
    const candidates = EffectArray.sort(
      this.bindings.filter((binding) => binding.name === name && contains(binding.scope, at)),
      Order.mapInput(Order.Number, (binding: Binding) => binding.scope.end - binding.scope.start),
    );
    const [first, second] = candidates;
    return first !== undefined && second?.scope === first.scope ? undefined : first;
  }

  stable(binding: Binding | undefined): Binding | undefined {
    return binding !== undefined && binding.stable && !this.writes.has(binding) ? binding : undefined;
  }

  imported(name: string, at: Span, exported: string, source: string, value = false): boolean {
    const binding = this.stable(this.resolve(name, at));
    return (
      binding !== undefined &&
      binding.imported?.source === source &&
      binding.imported.name === exported &&
      (!value || !binding.imported.typeOnly)
    );
  }

  coreType(annotation: TSTypeAnnotation | null | undefined, exported: string): boolean {
    const type = annotation?.typeAnnotation;
    return (
      type?.type === 'TSTypeReference' &&
      type.typeName.type === 'Identifier' &&
      this.imported(type.typeName.name, type, exported, coreRuntimeModule)
    );
  }

  effectCall(call: CallExpression, method: string): boolean {
    return (
      call.callee.type === 'MemberExpression' &&
      !call.callee.computed &&
      call.callee.object.type === 'Identifier' &&
      call.callee.property.type === 'Identifier' &&
      call.callee.property.name === method &&
      this.imported(call.callee.object.name, call.callee.object, 'Effect', 'effect', true)
    );
  }

  implementation(
    expression: Expression | null | undefined,
    seen: ReadonlySet<Binding> = new Set(),
  ): PreparationFunction | undefined {
    if (expression === undefined || expression === null) {
      return undefined;
    }
    if (expression.type === 'ArrowFunctionExpression' || expression.type === 'FunctionExpression') {
      return expression;
    }
    if (expression.type === 'Identifier') {
      const binding = this.stable(this.resolve(expression.name, expression));
      if (binding === undefined || seen.has(binding)) {
        return undefined;
      }
      return binding.implementation ?? this.implementation(binding.init, new Set([...seen, binding]));
    }
    // Only the real Effect.fn(label)(implementation), never a same-named wrapper.
    if (
      expression.type === 'CallExpression' &&
      expression.callee.type === 'CallExpression' &&
      this.effectCall(expression.callee, 'fn')
    ) {
      const [argument] = expression.arguments;
      return expression.arguments.length === 1 &&
        argument !== undefined &&
        argument.type !== 'SpreadElement' &&
        (argument.type === 'ArrowFunctionExpression' || argument.type === 'FunctionExpression')
        ? argument
        : undefined;
    }
    return undefined;
  }

  callable(expression: Expression): ResolvedPreparation | undefined {
    const implementation = this.implementation(expression);
    return implementation === undefined ? this.resolveCallable?.(expression) : [this, implementation];
  }

  contextInputs(node: PreparationFunction): readonly Binding[] {
    const contextType = this.readFinishes.has(node.start) ? 'ReadFinishContext' : 'ActionServicePreparationContext';
    return node.params.flatMap((parameter, index) => {
      const context =
        parameter.type === 'Identifier' &&
        (this.coreType(parameter.typeAnnotation, contextType) ||
          ((this.contextIndexes.get(node.start) ?? [1]).includes(index) &&
            parameter.typeAnnotation?.typeAnnotation === undefined));
      const binding = parameter.type === 'Identifier' && context ? this.resolve(parameter.name, parameter) : undefined;
      return binding === undefined || this.writes.has(binding) ? [] : [binding];
    });
  }

  isSnapshotCallback(call: CallExpression, argument: Span): boolean {
    if (call.arguments.length !== 1 || call.arguments[0] !== argument) {
      return false;
    }
    const owner = this.functions.find(
      (candidate) =>
        (this.preflights.has(candidate.start) || this.readFinishes.has(candidate.start)) && contains(candidate, call),
    );
    const { callee } = call;
    return (
      owner !== undefined &&
      callee.type === 'MemberExpression' &&
      !callee.computed &&
      callee.property.type === 'Identifier' &&
      callee.property.name === 'transaction' &&
      callee.object.type === 'Identifier' &&
      this.contextInputs(owner).some(
        (binding) =>
          this.resolve(callee.object.type === 'Identifier' ? callee.object.name : '', callee.object) === binding,
      )
    );
  }

  parent(node: Span): PreparationFunction | undefined {
    return EffectArray.sort(
      this.functions.filter((candidate) => candidate !== node && contains(candidate, node)),
      Order.mapInput(Order.Number, (candidate: PreparationFunction) => candidate.end - candidate.start),
    )[0];
  }

  returns(node: PreparationFunction): readonly Expression[] {
    const expressions: Expression[] = [];
    if (node.type === 'ArrowFunctionExpression' && node.body.type !== 'BlockStatement') {
      expressions.push(node.body);
    }
    new Visitor({
      ReturnStatement: (statement) => {
        if (statement.argument !== null && this.parent(statement) === node) {
          expressions.push(statement.argument);
        }
      },
    }).visit(this.program);
    return expressions.map((expression) => {
      let value = expression;
      while (value.type === 'ParenthesizedExpression') {
        value = value.expression;
      }
      return value;
    });
  }

  calledOnly(binding: Binding, within: Span, requireBoundary = false): boolean {
    let called = false;
    let escaped = false;
    new Visitor({
      Identifier: (node) => {
        if (node.start === binding.declaration.start || this.resolve(node.name, node) !== binding) {
          return;
        }
        const call = this.calls.find(
          (candidate) => candidate.callee === node || this.isSnapshotCallback(candidate, node),
        );
        const bounded =
          !requireBoundary ||
          this.functions.some(
            (candidate) =>
              (this.factories.has(candidate.start) ||
                this.preflights.has(candidate.start) ||
                this.readFinishes.has(candidate.start) ||
                this.privateConsumers.has(candidate.start)) &&
              contains(candidate, node),
          );
        called ||= call !== undefined;
        escaped ||= call === undefined || !contains(within, node) || !bounded;
      },
    }).visit(this.program);
    return called && !escaped;
  }
}

type ResolvedPreparation = readonly [PreparationSource, PreparationFunction];
type ResolvePreparation = (model: PreparationSource, expression: Expression) => ResolvedPreparation | undefined;

const exportedImplementation = (target: PreparationSource, name: string): PreparationFunction | undefined => {
  for (const statement of target.program.body) {
    if (
      statement.type === 'ExportNamedDeclaration' &&
      statement.source === null &&
      statement.declaration?.type === 'VariableDeclaration'
    ) {
      for (const declaration of statement.declaration.declarations) {
        if (declaration.id.type === 'Identifier' && declaration.id.name === name) {
          const binding = target.stable(target.resolve(name, declaration.id));
          return binding === undefined ? undefined : target.implementation(binding.init);
        }
      }
    }
  }
  return undefined;
};

interface SourceDefinition {
  readonly declaration?: Span;
  readonly exported: boolean;
  readonly model: PreparationSource;
  readonly name: string;
}

type ResolveDefinition = (model: PreparationSource, reference: Expression) => SourceDefinition | undefined;

const sourceDefinitionResolver =
  (
    models: Map<string, PreparationSource>,
    sources: ReadonlyMap<string, string>,
    dependency: (file: string, specifier: string) => string | undefined,
  ): ResolveDefinition =>
  (model, reference): SourceDefinition | undefined => {
    if (reference.type !== 'Identifier') {
      return undefined;
    }
    const binding = model.resolve(reference.name, reference);
    if (binding === undefined || model.writes.has(binding)) {
      return undefined;
    }
    if (binding.imported === undefined) {
      return { declaration: binding.declaration, exported: false, model, name: binding.name };
    }
    if (model.stable(binding) === undefined || binding.imported.typeOnly) {
      return undefined;
    }
    const file = [...models].find(([, candidate]) => candidate === model)?.[0];
    const targetFile = file === undefined ? undefined : dependency(file, binding.imported.source);
    const source = targetFile === undefined ? undefined : sources.get(targetFile);
    if (targetFile === undefined || source === undefined) {
      return undefined;
    }
    const target = models.get(targetFile) ?? new PreparationSource(targetFile, source);
    models.set(targetFile, target);
    return { exported: true, model: target, name: binding.imported.name };
  };

const nativeServiceClass = (definition: SourceDefinition): AstClass | undefined => {
  for (const statement of definition.model.program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (definition.exported && statement.type !== 'ExportNamedDeclaration') {
      continue;
    }
    if (declaration?.type === 'ClassDeclaration' && declaration.id?.name === definition.name) {
      if (!definition.exported && definition.declaration?.start !== declaration.id.start) {
        return undefined;
      }
      const binding = definition.model.resolve(definition.name, declaration.id);
      if (binding?.declaration.start === declaration.id.start && !definition.model.writes.has(binding)) {
        return declaration;
      }
    }
  }
  return undefined;
};

const nativeServiceContract = (definition: SourceDefinition): TSTypeLiteral | undefined => {
  const declaration = nativeServiceClass(definition);
  const superclass = declaration?.superClass;
  if (superclass?.type !== 'CallExpression' || superclass.callee.type !== 'CallExpression') {
    return undefined;
  }
  const service = superclass.callee;
  const { callee } = service;
  if (
    callee.type !== 'MemberExpression' ||
    callee.computed ||
    callee.property.type !== 'Identifier' ||
    callee.property.name !== 'Service' ||
    callee.object.type !== 'Identifier' ||
    service.arguments.length !== 0 ||
    !definition.model.imported(callee.object.name, callee.object, 'Context', 'effect', true)
  ) {
    return undefined;
  }
  const contract = service.typeArguments?.params.at(1);
  return contract?.type === 'TSTypeLiteral' ? contract : undefined;
};

const nativeServiceMethod = (definition: SourceDefinition, name: string): ResolvedPreparation | undefined => {
  const contract = nativeServiceContract(definition);
  if (contract === undefined) {
    return undefined;
  }
  const property = contract.members.find(
    (member) =>
      member.type === 'TSPropertySignature' &&
      !member.computed &&
      member.readonly &&
      member.key.type === 'Identifier' &&
      member.key.name === name,
  );
  const type = property?.type === 'TSPropertySignature' ? property.typeAnnotation?.typeAnnotation : undefined;
  if (type?.type !== 'TSTypeQuery' || type.exprName.type !== 'Identifier') {
    return undefined;
  }
  const implementation = definition.model.implementation(type.exprName);
  return implementation === undefined ? undefined : [definition.model, implementation];
};

const nativePreparationMethod = (
  model: PreparationSource,
  member: MemberExpression,
  resolveDefinition: ResolveDefinition,
): ResolvedPreparation | undefined => {
  if (member.computed || member.property.type !== 'Identifier' || member.object.type !== 'MemberExpression') {
    return undefined;
  }
  const option = member.object;
  if (
    option.computed ||
    option.property.type !== 'Identifier' ||
    option.property.name !== 'value' ||
    option.object.type !== 'Identifier'
  ) {
    return undefined;
  }
  const binding = model.stable(model.resolve(option.object.name, option.object));
  const acquisition =
    binding?.init?.type === 'YieldExpression' && binding.init.delegate ? binding.init.argument : undefined;
  if (
    acquisition?.type !== 'CallExpression' ||
    !model.effectCall(acquisition, 'serviceOption') ||
    acquisition.arguments.length !== 1
  ) {
    return undefined;
  }
  const [service] = acquisition.arguments;
  const definition = service?.type === 'Identifier' ? resolveDefinition(model, service) : undefined;
  return definition === undefined ? undefined : nativeServiceMethod(definition, member.property.name);
};

const preparationResolver = (
  models: Map<string, PreparationSource>,
  sources: ReadonlyMap<string, string>,
  dependency: (file: string, specifier: string) => string | undefined,
): ResolvePreparation => {
  const resolveDefinition = sourceDefinitionResolver(models, sources, dependency);
  const resolve: ResolvePreparation = (model, expression): ResolvedPreparation | undefined => {
    const local = model.implementation(expression);
    if (local !== undefined) {
      return [model, local];
    }
    if (expression.type === 'MemberExpression') {
      return nativePreparationMethod(model, expression, resolveDefinition);
    }
    if (expression.type !== 'Identifier' || model.stable(model.resolve(expression.name, expression)) === undefined) {
      return undefined;
    }
    const definition = resolveDefinition(model, expression);
    if (definition === undefined || definition.model === model) {
      return undefined;
    }
    definition.model.resolveCallable = (callee) => resolve(definition.model, callee);
    const implementation = exportedImplementation(definition.model, definition.name);
    return implementation === undefined ? undefined : [definition.model, implementation];
  };
  return resolve;
};

const registeredPreflights = (model: PreparationSource, resolve: ResolvePreparation): readonly ResolvedPreparation[] =>
  model.calls.flatMap((call) => {
    if (
      call.callee.type !== 'Identifier' ||
      !model.imported(call.callee.name, call.callee, 'defineAction', coreRuntimeModule, true)
    ) {
      return [];
    }
    const ordinary = call.arguments.at(2);
    const serviceFactory =
      ordinary === undefined || ordinary.type === 'SpreadElement' ? undefined : resolve(model, ordinary);
    if (serviceFactory !== undefined) {
      serviceFactory[0].factories.add(serviceFactory[1].start);
    }
    const options = call.arguments.at(3);
    if (
      options?.type !== 'ObjectExpression' ||
      options.properties.some((property) => property.type === 'SpreadElement' || property.computed)
    ) {
      return [];
    }
    return options.properties.flatMap((property) => {
      if (
        property.type !== 'Property' ||
        property.key.type !== 'Identifier' ||
        property.key.name !== 'prepareServices'
      ) {
        return [];
      }
      const resolved = resolve(model, property.value);
      return resolved === undefined ? [] : [resolved];
    });
  });

/** Only Core's direct pipeline finish slot introduces a Read owner-transaction context. */
const registeredReadFinishes = (
  model: PreparationSource,
  resolve: ResolvePreparation,
): readonly ResolvedPreparation[] =>
  model.calls.flatMap((call) => {
    if (
      call.callee.type !== 'Identifier' ||
      !model.imported(call.callee.name, call.callee, 'defineRead', coreRuntimeModule, true)
    ) {
      return [];
    }
    const pipeline = call.arguments.at(1);
    if (
      pipeline?.type !== 'ObjectExpression' ||
      pipeline.properties.some((property) => property.type === 'SpreadElement' || property.computed)
    ) {
      return [];
    }
    const ordinary = call.arguments.at(2);
    const factory = ordinary === undefined || ordinary.type === 'SpreadElement' ? undefined : resolve(model, ordinary);
    if (factory !== undefined) {
      factory[0].factories.add(factory[1].start);
    }
    return pipeline.properties.flatMap((property) => {
      if (
        property.type !== 'Property' ||
        property.kind !== 'init' ||
        property.key.type !== 'Identifier' ||
        property.key.name !== 'finish'
      ) {
        return [];
      }
      const finish = resolve(model, property.value);
      return finish === undefined ? [] : [finish];
    });
  });

const annotatedPreflights = (model: PreparationSource): readonly ResolvedPreparation[] =>
  model.bindings.flatMap((binding) => {
    const implementation =
      model.stable(binding) === undefined ? undefined : (binding.implementation ?? model.implementation(binding.init));
    if (implementation === undefined) {
      return [];
    }
    if (model.coreType(binding.annotation, 'ActionServiceFactory')) {
      model.factories.add(implementation.start);
    }
    if (model.coreType(implementation.returnType, 'ActionServiceFactory')) {
      for (const returned of model.returns(implementation)) {
        const factory = model.implementation(returned);
        if (factory !== undefined) {
          model.factories.add(factory.start);
        }
      }
    }
    return model.coreType(binding.annotation, 'ActionServicePreflight') ? [[model, implementation] as const] : [];
  });

const isFactorySignature = (model: PreparationSource, factory: PreparationFunction): boolean => {
  const [transaction, scope, revision] = factory.params;
  return (
    transaction?.type === 'Identifier' &&
    model.coreType(transaction.typeAnnotation, 'ScopedTransactionExecutor') &&
    scope?.type === 'Identifier' &&
    model.coreType(scope.typeAnnotation, 'OperationalScope') &&
    revision?.type === 'Identifier' &&
    revision.typeAnnotation?.typeAnnotation.type === 'TSStringKeyword'
  );
};

const helperPreflights = (
  model: PreparationSource,
  preflight: PreparationFunction,
  resolve: ResolvePreparation,
  contextType = 'ActionServicePreparationContext',
): readonly ResolvedPreparation[] => {
  const contexts = model.contextInputs(preflight);
  return model.calls
    .filter((candidate) => contains(preflight, candidate))
    .flatMap((call) => {
      const resolved = resolve(model, call.callee);
      if (resolved === undefined) {
        return [];
      }
      const [target, helper] = resolved;
      const passesContext = call.arguments.some((argument, index) => {
        const parameter = helper.params[index];
        return (
          argument.type === 'Identifier' &&
          contexts.some((context) => model.resolve(argument.name, argument) === context) &&
          parameter?.type === 'Identifier' &&
          target.coreType(parameter.typeAnnotation, contextType)
        );
      });
      return passesContext ? [resolved] : [];
    });
};

interface PreparationPort {
  readonly declaration: TSInterfaceDeclaration;
  readonly model: PreparationSource;
}

const portDeclaration = (target: PreparationSource, binding: Binding): PreparationPort | undefined => {
  const name = binding.imported?.name ?? binding.name;
  for (const statement of target.program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (binding.imported !== undefined && statement.type !== 'ExportNamedDeclaration') {
      continue;
    }
    if (
      declaration?.type === 'TSInterfaceDeclaration' &&
      declaration.id.name === name &&
      (binding.imported !== undefined || binding.declaration.start === declaration.id.start)
    ) {
      return { declaration, model: target };
    }
  }
  return undefined;
};

const preparationPort = (
  model: PreparationSource,
  annotation: TSTypeAnnotation | null | undefined,
  models: ReadonlyMap<string, PreparationSource>,
  dependency: (file: string, specifier: string) => string | undefined,
): PreparationPort | undefined => {
  const type = annotation?.typeAnnotation;
  if (type?.type !== 'TSTypeReference' || type.typeName.type !== 'Identifier') {
    return undefined;
  }
  const binding = model.resolve(type.typeName.name, type);
  const file = [...models].find(([, candidate]) => candidate === model)?.[0];
  const importedFile =
    file === undefined || binding?.imported === undefined ? undefined : dependency(file, binding.imported.source);
  const target = models.get(importedFile ?? '') ?? (binding?.imported === undefined ? model : undefined);
  if (
    target === undefined ||
    binding === undefined ||
    (binding.imported !== undefined && model.stable(binding) === undefined)
  ) {
    return undefined;
  }
  return portDeclaration(target, binding);
};

const portContextIndexes = (model: PreparationSource, signature: TSFunctionType): readonly number[] => {
  const result = signature.returnType.typeAnnotation;
  if (
    result.type !== 'TSTypeReference' ||
    result.typeName.type !== 'TSQualifiedName' ||
    result.typeName.left.type !== 'Identifier' ||
    result.typeName.right.name !== 'Effect' ||
    !model.imported(result.typeName.left.name, result, 'Effect', 'effect')
  ) {
    return [];
  }
  const factory = result.typeArguments?.params[0];
  if (
    factory?.type !== 'TSTypeReference' ||
    factory.typeName.type !== 'Identifier' ||
    !model.imported(factory.typeName.name, factory, 'ActionServiceFactory', coreRuntimeModule)
  ) {
    return [];
  }
  return signature.params.flatMap((parameter, index) =>
    parameter.type === 'Identifier' && model.coreType(parameter.typeAnnotation, 'ActionServicePreparationContext')
      ? [index]
      : [],
  );
};

const portMethods = (
  model: PreparationSource,
  implementation: PreparationFunction,
  port: PreparationPort,
): readonly ResolvedPreparation[] =>
  model.returns(implementation).flatMap((returned) => {
    if (returned.type !== 'ObjectExpression') {
      return [];
    }
    return returned.properties.flatMap((property) => {
      if (property.type !== 'Property' || property.computed || property.key.type !== 'Identifier') {
        return [];
      }
      const key = property.key.name;
      const signature = port.declaration.body.body.find(
        (candidate) =>
          candidate.type === 'TSPropertySignature' &&
          !candidate.computed &&
          candidate.key.type === 'Identifier' &&
          candidate.key.name === key,
      );
      const type = signature?.type === 'TSPropertySignature' ? signature.typeAnnotation?.typeAnnotation : undefined;
      const indexes = type?.type === 'TSFunctionType' ? portContextIndexes(port.model, type) : [];
      const method = model.implementation(property.value);
      if (method === undefined || indexes.length === 0) {
        return [];
      }
      model.contextIndexes.set(method.start, indexes);
      return [[model, method] as const];
    });
  });

/** A typed service port can carry Core's preparation contract through dependency injection. */
const portPreflights = (
  model: PreparationSource,
  models: ReadonlyMap<string, PreparationSource>,
  dependency: (file: string, specifier: string) => string | undefined,
): readonly ResolvedPreparation[] =>
  model.bindings.flatMap((binding) => {
    const implementation =
      model.stable(binding) === undefined ? undefined : (binding.implementation ?? model.implementation(binding.init));
    const port =
      implementation === undefined ? undefined : preparationPort(model, implementation.returnType, models, dependency);
    return implementation === undefined || port === undefined ? [] : portMethods(model, implementation, port);
  });

const markSafeCalls = (model: PreparationSource, binding: Binding): void => {
  for (const call of model.calls) {
    if (call.callee.type === 'Identifier' && model.resolve(call.callee.name, call.callee) === binding) {
      model.safeCalls.add(call.start);
    }
  }
};

const privateSnapshotInputs = (model: PreparationSource, preflight: PreparationFunction): void => {
  for (const call of model.calls) {
    const [argument] = call.arguments;
    if (
      argument !== undefined &&
      argument.type !== 'SpreadElement' &&
      argument.type !== 'Identifier' &&
      contains(preflight, call) &&
      model.isSnapshotCallback(call, argument)
    ) {
      const implementation = model.implementation(argument);
      if (implementation !== undefined) {
        model.privateConsumers.add(implementation.start);
      }
    }
  }
};

const privatePreparationInputs = (model: PreparationSource, preflight: PreparationFunction): void => {
  privateSnapshotInputs(model, preflight);
  for (const parameter of preflight.params) {
    if (parameter.type === 'Identifier' && parameter.typeAnnotation?.typeAnnotation.type === 'TSFunctionType') {
      const binding = model.resolve(parameter.name, parameter);
      if (binding !== undefined && model.calledOnly(binding, preflight)) {
        model.callbackInputs.push(
          ...parameter.typeAnnotation.typeAnnotation.params.flatMap((input) =>
            input.type === 'Identifier' &&
            model.coreType(input.typeAnnotation, 'ScopedTransactionExecutor') &&
            input.typeAnnotation !== null &&
            input.typeAnnotation !== undefined
              ? [input.typeAnnotation]
              : [],
          ),
        );
        markSafeCalls(model, binding);
      }
    }
  }
};

const privateFactoryConsumers = (model: PreparationSource): void => {
  let changed = true;
  while (changed) {
    changed = false;
    for (const binding of model.bindings) {
      const implementation =
        model.stable(binding) === undefined
          ? undefined
          : (binding.implementation ?? model.implementation(binding.init));
      if (
        implementation !== undefined &&
        !model.privateConsumers.has(implementation.start) &&
        model.calledOnly(binding, model.program, true)
      ) {
        model.privateConsumers.add(implementation.start);
        changed = true;
      }
    }
  }
};

/** Error mapping preserves the acquired success value; arbitrary success transforms do not. */
const preparationEffect = (model: PreparationSource, expression: Expression | null): CallExpression | undefined => {
  if (expression?.type !== 'CallExpression') {
    return undefined;
  }
  const { callee } = expression;
  if (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'pipe'
  ) {
    if (
      !expression.arguments.every(
        (argument) => argument.type === 'CallExpression' && model.effectCall(argument, 'mapError'),
      )
    ) {
      return undefined;
    }
    return preparationEffect(model, callee.object);
  }
  return expression;
};

const collectsPreparationValues = (model: PreparationSource, call: CallExpression): boolean => {
  if (!model.effectCall(call, 'all') || call.arguments.length > 2) {
    return false;
  }
  const options = call.arguments.at(1);
  if (options === undefined) {
    return true;
  }
  return (
    options.type === 'ObjectExpression' &&
    options.properties.every((property) => {
      if (
        property.type !== 'Property' ||
        property.computed ||
        property.key.type !== 'Identifier' ||
        property.kind !== 'init'
      ) {
        return false;
      }
      return (
        property.key.name === 'concurrency' ||
        (property.value.type === 'Literal' &&
          ((property.key.name === 'discard' && property.value.value === false) ||
            (property.key.name === 'mode' && property.value.value === 'default')))
      );
    })
  );
};

const preparationAcquisition = (model: PreparationSource, binding: Binding): CallExpression | undefined => {
  if (binding.init?.type !== 'YieldExpression' || !binding.init.delegate) {
    return undefined;
  }
  const call = preparationEffect(model, binding.init.argument);
  if (call === undefined || binding.projection === undefined) {
    return call;
  }
  const [effects] = call.arguments;
  if (
    !collectsPreparationValues(model, call) ||
    effects?.type !== 'ArrayExpression' ||
    effects.elements.some((element) => element?.type === 'SpreadElement')
  ) {
    return undefined;
  }
  const element = effects.elements[binding.projection];
  return element === null || element === undefined || element.type === 'SpreadElement'
    ? undefined
    : preparationEffect(model, element);
};

const preparedFactoryCalls = (model: PreparationSource, resolve: ResolvePreparation): void => {
  for (const binding of model.bindings) {
    const call = model.stable(binding) === undefined ? undefined : preparationAcquisition(model, binding);
    const resolved = call === undefined ? undefined : resolve(model, call.callee);
    if (resolved !== undefined && resolved[0].preflights.has(resolved[1].start)) {
      markSafeCalls(model, binding);
    }
  }
};

/** Resolve only exact named imports/exports; unknown barrels and mutable aliases stay untrusted. */
export const actionPreparationBoundaries = (
  sources: ReadonlyMap<string, string>,
  dependency: (file: string, specifier: string) => string | undefined,
): ReadonlyMap<string, PreparationSource> => {
  const models = new Map<string, PreparationSource>();
  for (const [file, source] of sources) {
    if (
      /\b(?:ScopedTransactionExecutor|ActionServicePreflight|ActionServiceFactory|defineAction|ActionServicePreparationContext|defineRead|ReadFinishContext)\b/u.test(
        source,
      )
    ) {
      models.set(file, new PreparationSource(file, source));
    }
  }
  const resolve = preparationResolver(models, sources, dependency);
  for (const model of models.values()) {
    model.resolveCallable = (expression) => resolve(model, expression);
  }
  const pending = [...models.values()].flatMap((model) => [
    ...annotatedPreflights(model),
    ...registeredPreflights(model, resolve),
    ...portPreflights(model, models, dependency),
  ]);
  while (pending.length > 0) {
    const item = pending.pop();
    if (item === undefined || item[0].preflights.has(item[1].start)) {
      continue;
    }
    const [model, preflight] = item;
    model.preflights.add(preflight.start);
    for (const returned of model.returns(preflight)) {
      const factory = model.implementation(returned);
      if (factory !== undefined && isFactorySignature(model, factory)) {
        model.factories.add(factory.start);
      }
    }
    // Helpers must receive the actual Core context, not merely bear a preflight-like name.
    pending.push(...helperPreflights(model, preflight, resolve));
    privatePreparationInputs(model, preflight);
  }
  const readFinishes = [...models.values()].flatMap((model) => registeredReadFinishes(model, resolve));
  while (readFinishes.length > 0) {
    const item = readFinishes.pop();
    if (item === undefined || item[0].readFinishes.has(item[1].start)) {
      continue;
    }
    const [model, finish] = item;
    model.readFinishes.add(finish.start);
    readFinishes.push(...helperPreflights(model, finish, resolve, 'ReadFinishContext'));
    privateSnapshotInputs(model, finish);
  }
  for (const model of models.values()) {
    preparedFactoryCalls(model, resolve);
    privateFactoryConsumers(model);
  }
  return models;
};
