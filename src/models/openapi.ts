import { stableChecksum } from '../lib/utils';

/**
 * OpenAPI 文档解析与引用展开。
 *
 * 解析结果称为"引用快照"：把 components 里的共享定义按 $ref 就地展开后，
 * 得到每个操作打平的参数、请求体、响应字段和错误码集合。
 * 共享定义的改法因此会反映到每一个引用它的操作上。
 * 引用成环、悬空引用和 JSON 损坏都会被识别并拒绝生成快照。
 */

export type SnapshotWarningKind = 'cycle' | 'broken_ref' | 'parse_error' | 'baseline_missing';

export interface SnapshotWarning {
  kind: SnapshotWarningKind;
  ref: string;
  detail: string;
}

export type FieldDirection = 'request' | 'response';

export interface ResolvedField {
  /** 操作内稳定标识，例如 param.query.currency / body.order.total.amount / resp.items[].sku */
  id: string;
  /** 字段名（路径最后一段） */
  name: string;
  direction: FieldDirection;
  /** 规范化类型签名，例如 string、integer、array<string>、string(date-time) */
  type: string;
  required: boolean;
  enumValues: string[];
  /** 展开时经过的引用链，例如 ['#/components/schemas/Order', '#/components/schemas/Money'] */
  refs: string[];
}

export interface ResolvedOperation {
  path: string;
  method: string;
  summary: string;
  fields: ResolvedField[];
  errorCodes: string[];
}

export interface ReferenceSnapshot {
  /** 源定义规范化后的校验值，用于重复导入检测 */
  checksum: string;
  resolvedAt: string;
  operations: ResolvedOperation[];
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];
const MAX_DEPTH = 16;

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function asArray(value: unknown): Json[] | undefined {
  return Array.isArray(value) ? (value as Json[]) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** 排序键后的规范化 JSON，同一语义的文档得到同一校验值 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(',')}]`;
  }
  const entries = Object.keys(value as JsonObject)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalStringify((value as JsonObject)[key])}`);
  return `{${entries.join(',')}}`;
}

export interface ParsedDocument {
  title: string;
  version: string;
  paths: Record<string, JsonObject>;
  schemas: Record<string, JsonObject>;
  canonical: string;
}

export type ParseResult = { ok: true; doc: ParsedDocument } | { ok: false; error: string };

export function parseOpenApiDocument(source: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (error) {
    return {
      ok: false,
      error: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const root = asObject(raw);
  if (!root) {
    return { ok: false, error: '文档不是有效的 OpenAPI 对象' };
  }
  const info = asObject(root.info);
  const title = asString(info?.title) ?? '';
  if (!title) {
    return { ok: false, error: 'OpenAPI 文档缺少 info.title' };
  }
  const paths: Record<string, JsonObject> = {};
  for (const [path, pathItem] of Object.entries(asObject(root.paths) ?? {})) {
    const item = asObject(pathItem);
    if (item) paths[path] = item;
  }
  const schemas: Record<string, JsonObject> = {};
  const components = asObject(root.components);
  for (const [name, schema] of Object.entries(asObject(components?.schemas) ?? {})) {
    const schemaObject = asObject(schema);
    if (schemaObject) schemas[name] = schemaObject;
  }
  return {
    ok: true,
    doc: {
      title,
      version: asString(info?.version) ?? '',
      paths,
      schemas,
      canonical: canonicalStringify(raw),
    },
  };
}

export type SnapshotBuildResult =
  | { ok: true; snapshot: ReferenceSnapshot }
  | { ok: false; error: string; warnings: SnapshotWarning[] };

/**
 * 解析源定义并展开全部引用，生成引用快照。
 * 引用成环、悬空引用或文档损坏时返回失败，调用方应保留上一份有效差异。
 */
export function buildReferenceSnapshot(source: string): SnapshotBuildResult {
  const parsed = parseOpenApiDocument(source);
  if (!parsed.ok) {
    return {
      ok: false,
      error: parsed.error,
      warnings: [{ kind: 'parse_error', ref: '', detail: parsed.error }],
    };
  }
  const warnings: SnapshotWarning[] = [];
  const operations: ResolvedOperation[] = [];
  for (const [path, pathItem] of Object.entries(parsed.doc.paths).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const sharedParameters = asArray(pathItem.parameters) ?? [];
    for (const method of HTTP_METHODS) {
      const operation = asObject(pathItem[method]);
      if (!operation) continue;
      operations.push(
        resolveOperation(path, method, operation, sharedParameters, parsed.doc.schemas, warnings),
      );
    }
  }
  if (warnings.length) {
    const summary = warnings
      .slice(0, 3)
      .map((warning) => warning.detail)
      .join('；');
    return {
      ok: false,
      error: `引用展开失败（${warnings.length} 处）：${summary}`,
      warnings,
    };
  }
  return {
    ok: true,
    snapshot: {
      checksum: stableChecksum(parsed.doc.canonical),
      resolvedAt: new Date().toISOString(),
      operations,
    },
  };
}

function resolveOperation(
  path: string,
  method: string,
  operation: JsonObject,
  sharedParameters: Json[],
  schemas: Record<string, JsonObject>,
  warnings: SnapshotWarning[],
): ResolvedOperation {
  const fields: ResolvedField[] = [];
  const errorCodes = new Set<string>();

  // 1. 路径级与操作级参数（query/path/header 等）
  const parameters = [...sharedParameters, ...(asArray(operation.parameters) ?? [])];
  for (const parameter of parameters) {
    const resolved = dereference(asObject(parameter), schemas, [], warnings);
    if (!resolved) continue;
    const name = asString(resolved.schema.name);
    const where = asString(resolved.schema.in) ?? 'query';
    if (!name) continue;
    const schema = dereference(asObject(resolved.schema.schema), schemas, resolved.refs, warnings);
    fields.push({
      id: `param.${where}.${name}`,
      name,
      direction: 'request',
      type: schema ? typeSignature(schema.schema) : 'any',
      required: resolved.schema.required === true || where === 'path',
      enumValues: schema ? enumOf(schema.schema) : [],
      refs: schema?.refs ?? resolved.refs,
    });
  }

  // 2. 请求体
  const requestSchema = jsonSchemaOf(asObject(operation.requestBody));
  if (requestSchema) {
    walkSchema(requestSchema, '', true, [], {
      direction: 'request',
      idPrefix: 'body',
      schemas,
      warnings,
      out: fields,
    });
  }

  // 3. 成功响应（取第一个 2xx）
  const responses = asObject(operation.responses) ?? {};
  const successCode = Object.keys(responses)
    .filter((code) => /^2\d\d$/.test(code))
    .sort()[0];
  if (successCode) {
    const responseSchema = jsonSchemaOf(asObject(responses[successCode]));
    if (responseSchema) {
      walkSchema(responseSchema, '', true, [], {
        direction: 'response',
        idPrefix: 'resp',
        schemas,
        warnings,
        out: fields,
      });
    }
  }

  // 4. 错误码：4xx/5xx 响应里 code/errorCode 字段的枚举，以及操作级 x-error-codes
  for (const [code, response] of Object.entries(responses)) {
    if (!/^[45]\d\d$/.test(code)) continue;
    const errorSchema = jsonSchemaOf(asObject(response));
    if (errorSchema) {
      collectErrorCodes(errorSchema, schemas, warnings, [], errorCodes, 0);
    }
  }
  for (const value of asArray(operation['x-error-codes']) ?? []) {
    const code = asString(value);
    if (code) errorCodes.add(code);
  }

  return {
    path,
    method: method.toUpperCase(),
    summary: asString(operation.summary) ?? '',
    fields,
    errorCodes: [...errorCodes].sort(),
  };
}

interface WalkContext {
  direction: FieldDirection;
  idPrefix: string;
  schemas: Record<string, JsonObject>;
  warnings: SnapshotWarning[];
  out: ResolvedField[];
}

/** 递归展开 schema，只落地叶子字段（中间对象的存在由子字段隐含） */
function walkSchema(
  schema: JsonObject,
  path: string,
  required: boolean,
  refs: string[],
  ctx: WalkContext,
  depth = 0,
): void {
  if (depth > MAX_DEPTH) {
    ctx.warnings.push({
      kind: 'cycle',
      ref: refs[refs.length - 1] ?? path,
      detail: `字段 ${path || '(根)'} 展开深度超过 ${MAX_DEPTH} 层，按引用成环处理`,
    });
    return;
  }

  const ref = asString(schema.$ref);
  if (ref) {
    const name = refName(ref);
    const target = name ? ctx.schemas[name] : undefined;
    if (!name || !target) {
      ctx.warnings.push({
        kind: 'broken_ref',
        ref,
        detail: `字段 ${path || '(根)'} 的引用 ${ref} 无法解析`,
      });
      return;
    }
    if (refs.includes(ref)) {
      ctx.warnings.push({
        kind: 'cycle',
        ref,
        detail: `引用成环：${[...refs, ref].join(' → ')}`,
      });
      return;
    }
    walkSchema(target, path, required, [...refs, ref], ctx, depth + 1);
    return;
  }

  // allOf 合并展开
  const allOf = asArray(schema.allOf);
  if (allOf?.length) {
    for (const sub of allOf) {
      const subSchema = asObject(sub);
      if (subSchema) walkSchema(subSchema, path, required, refs, ctx, depth + 1);
    }
  }

  const type = asString(schema.type);
  const properties = asObject(schema.properties);
  if (type === 'object' || properties) {
    const requiredList = new Set(
      (asArray(schema.required) ?? []).filter((item): item is string => typeof item === 'string'),
    );
    for (const [propName, propSchemaRaw] of Object.entries(properties ?? {})) {
      const childPath = path ? `${path}.${propName}` : propName;
      walkSchema(
        asObject(propSchemaRaw) ?? {},
        childPath,
        requiredList.has(propName),
        refs,
        ctx,
        depth + 1,
      );
    }
    return;
  }

  if (type === 'array') {
    const items = asObject(schema.items);
    if (!items) {
      pushLeaf(ctx, path, required, 'array<any>', [], refs);
      return;
    }
    const itemType = asString(items.type);
    const itemIsObject =
      itemType === 'object' || Boolean(asObject(items.properties)) || Boolean(asString(items.$ref));
    if (itemIsObject) {
      // 对象数组：子字段落在 path[].child 上
      walkSchema(items, `${path}[]`, required, refs, ctx, depth + 1);
    } else {
      // 标量数组：整体作为一个叶子字段
      pushLeaf(ctx, path, required, `array<${typeSignature(items)}>`, enumOf(items), refs);
    }
    return;
  }

  pushLeaf(ctx, path, required, typeSignature(schema), enumOf(schema), refs);
}

function pushLeaf(
  ctx: WalkContext,
  path: string,
  required: boolean,
  type: string,
  enumValues: string[],
  refs: string[],
): void {
  if (!path) return;
  ctx.out.push({
    id: `${ctx.idPrefix}.${path}`,
    name: path.split('.').pop()?.replace(/\[\]$/, '') ?? path,
    direction: ctx.direction,
    type,
    required,
    enumValues,
    refs,
  });
}

/** 在错误响应 schema 中收集 code/errorCode 字段的枚举值 */
function collectErrorCodes(
  schema: JsonObject,
  schemas: Record<string, JsonObject>,
  warnings: SnapshotWarning[],
  refs: string[],
  codes: Set<string>,
  depth: number,
): void {
  if (depth > MAX_DEPTH) return;
  const ref = asString(schema.$ref);
  if (ref) {
    const name = refName(ref);
    const target = name ? schemas[name] : undefined;
    if (!name || !target) {
      warnings.push({ kind: 'broken_ref', ref, detail: `错误响应的引用 ${ref} 无法解析` });
      return;
    }
    if (refs.includes(ref)) {
      warnings.push({ kind: 'cycle', ref, detail: `引用成环：${[...refs, ref].join(' → ')}` });
      return;
    }
    collectErrorCodes(target, schemas, warnings, [...refs, ref], codes, depth + 1);
    return;
  }
  for (const [propName, propSchemaRaw] of Object.entries(asObject(schema.properties) ?? {})) {
    const propSchema = asObject(propSchemaRaw);
    if (!propSchema) continue;
    if (propName === 'code' || propName === 'errorCode') {
      for (const value of enumOf(propSchema)) codes.add(value);
    }
    if (asString(propSchema.$ref) || asString(propSchema.type) === 'object') {
      collectErrorCodes(propSchema, schemas, warnings, refs, codes, depth + 1);
    }
  }
}

/** 解析一层 $ref，返回目标 schema 与经过的引用链 */
function dereference(
  schema: JsonObject | undefined,
  schemas: Record<string, JsonObject>,
  refs: string[],
  warnings: SnapshotWarning[],
): { schema: JsonObject; refs: string[] } | undefined {
  let current = schema;
  let chain = refs;
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    if (!current) return undefined;
    const ref = asString(current.$ref);
    if (!ref) return { schema: current, refs: chain };
    const name = refName(ref);
    const target = name ? schemas[name] : undefined;
    if (!name || !target) {
      warnings.push({ kind: 'broken_ref', ref, detail: `引用 ${ref} 无法解析` });
      return undefined;
    }
    if (chain.includes(ref)) {
      warnings.push({ kind: 'cycle', ref, detail: `引用成环：${[...chain, ref].join(' → ')}` });
      return undefined;
    }
    chain = [...chain, ref];
    current = target;
  }
  warnings.push({ kind: 'cycle', ref: chain[chain.length - 1] ?? '', detail: '引用链过深，按成环处理' });
  return undefined;
}

function jsonSchemaOf(container: JsonObject | undefined): JsonObject | undefined {
  const content = asObject(container?.content);
  if (!content) return undefined;
  for (const [mime, media] of Object.entries(content)) {
    if (!mime.includes('json')) continue;
    const schema = asObject(asObject(media)?.schema);
    if (schema) return schema;
  }
  return undefined;
}

function refName(ref: string): string | null {
  const prefix = '#/components/schemas/';
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : null;
}

function typeSignature(schema: JsonObject): string {
  const type = asString(schema.type);
  const format = asString(schema.format);
  if (!type) return 'any';
  if (type === 'array') {
    const items = asObject(schema.items);
    return `array<${items ? typeSignature(items) : 'any'}>`;
  }
  return format ? `${type}(${format})` : type;
}

function enumOf(schema: JsonObject): string[] {
  const values = asArray(schema.enum);
  if (!values) return [];
  return values
    .map((value) => (typeof value === 'string' ? value : JSON.stringify(value)))
    .sort();
}
