import { parseMiniYaml } from '../lib/mini-yaml';

export class OpenApiParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenApiParseError';
  }
}

export class OpenApiCycleError extends Error {
  readonly chain: string[];

  constructor(chain: string[]) {
    super(`引用成环：${chain.join(' → ')}`);
    this.name = 'OpenApiCycleError';
    this.chain = chain;
  }
}

export interface FieldEntry {
  location: 'request' | 'response';
  /** 展开引用后的点分路径，例如 totals.currency */
  path: string;
  name: string;
  baseType: string;
  /** 类型签名，包含约束，例如 integer(minimum=1) 或 array<string> */
  signature: string;
  required: boolean;
  enumValues: string[] | null;
  /** 该字段经由哪些共享定义展开而来 */
  refs: string[];
}

export interface OperationEntry {
  path: string;
  method: string;
  requestFields: FieldEntry[];
  responseFields: FieldEntry[];
  errorCodes: string[];
}

export interface RefUsage {
  ref: string;
  usedBy: string[];
}

export interface FlattenedDoc {
  operations: OperationEntry[];
  refUsage: RefUsage[];
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];
const CONSTRAINT_KEYS = [
  'format',
  'maxLength',
  'minLength',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minItems',
  'maxItems',
  'uniqueItems',
  'multipleOf',
] as const;
const MAX_DEPTH = 24;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 依次尝试 JSON 与 YAML 子集解析接口定义，失败抛出 OpenApiParseError。 */
export function parseOpenApiDocument(source: string): JsonObject {
  let parsed: unknown = null;
  let jsonFailed = false;
  try {
    parsed = JSON.parse(source);
  } catch {
    jsonFailed = true;
  }
  if (jsonFailed) {
    try {
      parsed = parseMiniYaml(source);
    } catch (error) {
      throw new OpenApiParseError(
        `接口定义无法解析：${error instanceof Error ? error.message : '未知格式错误'}`,
      );
    }
  }
  if (!isObject(parsed)) {
    throw new OpenApiParseError('接口定义根节点必须是对象');
  }
  if (!isObject(parsed.paths)) {
    throw new OpenApiParseError('接口定义缺少 paths 节点');
  }
  return parsed;
}

function resolveRef(doc: JsonObject, ref: string): JsonObject {
  if (!ref.startsWith('#/')) {
    throw new OpenApiParseError(`暂不支持外部引用 ${ref}`);
  }
  const segments = ref
    .slice(2)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
  let node: unknown = doc;
  for (const segment of segments) {
    if (!isObject(node)) {
      throw new OpenApiParseError(`引用 ${ref} 无法解析`);
    }
    node = node[segment];
  }
  if (!isObject(node)) {
    throw new OpenApiParseError(`引用 ${ref} 的目标不存在或不是对象`);
  }
  return node;
}

interface FlattenContext {
  doc: JsonObject;
  refUsage: Map<string, Set<string>>;
  usageTag: string;
}

function noteRefUsage(ctx: FlattenContext, ref: string): void {
  const bucket = ctx.refUsage.get(ref) ?? new Set<string>();
  bucket.add(ctx.usageTag);
  ctx.refUsage.set(ref, bucket);
}

/** 沿 $ref 链解析到具体 Schema，检测循环引用并记录引用关系。 */
function resolveSchema(
  ctx: FlattenContext,
  node: unknown,
  refStack: string[],
  activeRefs: string[],
): { schema: JsonObject; refStack: string[]; activeRefs: string[] } {
  let schema = node;
  let stack = refStack;
  let refs = activeRefs;
  let hops = 0;
  while (isObject(schema) && typeof schema.$ref === 'string') {
    const ref = schema.$ref;
    if (stack.includes(ref)) {
      throw new OpenApiCycleError([...stack, ref]);
    }
    hops += 1;
    if (hops > MAX_DEPTH) {
      throw new OpenApiParseError(`引用 ${ref} 链路过长，疑似循环`);
    }
    noteRefUsage(ctx, ref);
    schema = resolveRef(ctx.doc, ref);
    stack = [...stack, ref];
    refs = [...refs, ref];
  }
  if (!isObject(schema)) {
    throw new OpenApiParseError('Schema 节点必须是对象');
  }
  return { schema, refStack: stack, activeRefs: refs };
}

function detectBaseType(schema: JsonObject): string {
  if (typeof schema.type === 'string') return schema.type;
  if (isObject(schema.properties)) return 'object';
  if (isObject(schema.items)) return 'array';
  if (Array.isArray(schema.enum)) return 'string';
  return 'any';
}

function constraintSuffix(schema: JsonObject): string {
  const parts = CONSTRAINT_KEYS.filter((key) => schema[key] !== undefined).map(
    (key) => `${key}=${JSON.stringify(schema[key])}`,
  );
  return parts.length ? `(${parts.join(',')})` : '';
}

function resolveSignature(
  ctx: FlattenContext,
  node: unknown,
  refStack: string[],
  depth: number,
): string {
  if (depth > MAX_DEPTH) {
    throw new OpenApiParseError('Schema 嵌套过深，疑似循环引用');
  }
  const { schema, refStack: stack } = resolveSchema(ctx, node, refStack, []);
  const baseType = detectBaseType(schema);
  const suffix = constraintSuffix(schema);
  if (baseType === 'array' && isObject(schema.items)) {
    return `array<${resolveSignature(ctx, schema.items, stack, depth + 1)}>${suffix}`;
  }
  return `${baseType}${suffix}`;
}

function fieldName(path: string): string {
  const last = path.split('.').pop() ?? path;
  return last.replace(/\[\]$/, '');
}

function walkSchema(
  ctx: FlattenContext,
  node: unknown,
  location: 'request' | 'response',
  path: string,
  required: boolean,
  refStack: string[],
  activeRefs: string[],
  pushSelf: boolean,
  out: FieldEntry[],
  depth: number,
): void {
  if (depth > MAX_DEPTH) {
    throw new OpenApiParseError('Schema 嵌套过深，疑似循环引用');
  }
  if (!isObject(node)) return;
  const resolved = resolveSchema(ctx, node, refStack, activeRefs);
  const { schema } = resolved;
  const baseType = detectBaseType(schema);
  const signature = resolveSignature(ctx, schema, resolved.refStack, depth);

  if (pushSelf && path) {
    out.push({
      location,
      path,
      name: fieldName(path),
      baseType,
      signature,
      required,
      enumValues: Array.isArray(schema.enum) ? schema.enum.map((item) => String(item)) : null,
      refs: resolved.activeRefs,
    });
  }

  const requiredList = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === 'string')
    : [];
  if (isObject(schema.properties)) {
    for (const [prop, subSchema] of Object.entries(schema.properties)) {
      walkSchema(
        ctx,
        subSchema,
        location,
        path ? `${path}.${prop}` : prop,
        requiredList.includes(prop),
        resolved.refStack,
        resolved.activeRefs,
        true,
        out,
        depth + 1,
      );
    }
  }
  if (baseType === 'array' && isObject(schema.items)) {
    walkSchema(
      ctx,
      schema.items,
      location,
      `${path}[]`,
      false,
      resolved.refStack,
      resolved.activeRefs,
      false,
      out,
      depth + 1,
    );
  }
}

function extractBodySchema(holder: unknown): unknown {
  if (!isObject(holder) || !isObject(holder.content)) return null;
  const contents = Object.values(holder.content);
  for (const media of contents) {
    if (isObject(media) && isObject(media.schema)) return media.schema;
  }
  return null;
}

function extractResponseSchema(operation: JsonObject): unknown {
  if (!isObject(operation.responses)) return null;
  const responses = operation.responses;
  const successKey =
    Object.keys(responses).find((key) => key === '200') ??
    Object.keys(responses).find((key) => /^2\d\d$/.test(key)) ??
    Object.keys(responses).find((key) => key === 'default');
  if (!successKey) return null;
  return extractBodySchema(responses[successKey]);
}

function extractErrorCodes(operation: JsonObject): string[] {
  const raw = operation['x-error-codes'];
  if (!Array.isArray(raw)) return [];
  return Array.from(new Set(raw.map((item) => String(item)))).sort();
}

/** 解析并展开接口定义：每个操作的请求/响应字段、错误码与共享定义引用关系。 */
export function flattenOpenApi(doc: JsonObject): FlattenedDoc {
  const paths = doc.paths as JsonObject;
  const operations: OperationEntry[] = [];
  const refUsage = new Map<string, Set<string>>();

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isObject(pathItem)) continue;
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!isObject(operation)) continue;
      const usageTag = `${method.toUpperCase()} ${path}`;
      const ctx: FlattenContext = { doc, refUsage, usageTag };

      const requestFields: FieldEntry[] = [];
      const requestSchema = extractBodySchema(operation.requestBody);
      if (requestSchema) {
        walkSchema(ctx, requestSchema, 'request', '', false, [], [], false, requestFields, 0);
      }

      const responseFields: FieldEntry[] = [];
      const responseSchema = extractResponseSchema(operation);
      if (responseSchema) {
        walkSchema(ctx, responseSchema, 'response', '', false, [], [], false, responseFields, 0);
      }

      operations.push({
        path,
        method: method.toUpperCase(),
        requestFields,
        responseFields,
        errorCodes: extractErrorCodes(operation),
      });
    }
  }

  operations.sort((left, right) =>
    `${left.method} ${left.path}`.localeCompare(`${right.method} ${right.path}`),
  );

  return {
    operations,
    refUsage: Array.from(refUsage.entries())
      .map(([ref, usedBy]) => ({ ref, usedBy: Array.from(usedBy).sort() }))
      .sort((left, right) => left.ref.localeCompare(right.ref)),
  };
}

/** 从源文本一步得到展开后的结构，解析或引用失败时抛错。 */
export function flattenFromSource(source: string): FlattenedDoc {
  return flattenOpenApi(parseOpenApiDocument(source));
}
