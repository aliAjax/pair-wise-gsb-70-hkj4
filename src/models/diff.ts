import { stableChecksum } from '../lib/utils';
import {
  classifyChange,
  type ChangeKind,
  type ContractChange,
  type Exemption,
} from './contract';
import type { FieldDirection, ReferenceSnapshot, ResolvedField, ResolvedOperation } from './openapi';

/**
 * 契约差异引擎。
 *
 * 以最近冻结版本的引用快照为基线，与当前工作副本的引用快照逐操作、逐字段比较，
 * 识别字段新增/删除/移动、类型收紧、枚举收缩/扩展、必填变化和错误码上下线。
 * 变化 id 由内容决定，重复计算得到同一份差异。
 */

interface OperationRef {
  path: string;
  method: string;
}

interface ChangeSpec {
  op: OperationRef;
  kind: ChangeKind;
  direction: FieldDirection;
  /** 操作内字段标识，用于 fingerprint */
  fieldId: string;
  /** 展示用字段路径或错误码 */
  field: string;
  before: string;
  after: string;
  refs: string[];
  typeRelation?: 'narrowed' | 'widened' | 'incompatible';
  beforeRequired?: boolean;
  afterRequired?: boolean;
}

export function diffSnapshots(
  baseline: ReferenceSnapshot | null,
  current: ReferenceSnapshot,
): ContractChange[] {
  const changes: ContractChange[] = [];
  const beforeOps = new Map(
    (baseline?.operations ?? []).map((op) => [`${op.method} ${op.path}`, op]),
  );
  const afterOps = new Map(current.operations.map((op) => [`${op.method} ${op.path}`, op]));
  const keys = [...new Set([...beforeOps.keys(), ...afterOps.keys()])].sort();
  for (const key of keys) {
    diffOperation(beforeOps.get(key) ?? null, afterOps.get(key) ?? null, changes);
  }
  return changes.sort(
    (left, right) =>
      `${left.path} ${left.method} ${left.direction} ${left.field} ${left.kind}`.localeCompare(
        `${right.path} ${right.method} ${right.direction} ${right.field} ${right.kind}`,
      ),
  );
}

function diffOperation(
  before: ResolvedOperation | null,
  after: ResolvedOperation | null,
  out: ContractChange[],
): void {
  const op: OperationRef = {
    path: (after ?? before)?.path ?? '',
    method: (after ?? before)?.method ?? '',
  };
  const beforeFields = new Map((before?.fields ?? []).map((field) => [field.id, field]));
  const afterFields = new Map((after?.fields ?? []).map((field) => [field.id, field]));

  // 共有字段：类型、必填、枚举
  for (const [id, afterField] of afterFields) {
    const beforeField = beforeFields.get(id);
    if (!beforeField) continue;
    diffFieldType(op, beforeField, afterField, out);
    diffFieldRequired(op, beforeField, afterField, out);
    diffFieldEnum(op, beforeField, afterField, out);
  }

  const removed = [...beforeFields.values()].filter((field) => !afterFields.has(field.id));
  const added = [...afterFields.values()].filter((field) => !beforeFields.has(field.id));

  // 字段移动：同方向、同名、同类型的删除+新增配对为一次移动
  const movedFrom = new Set<string>();
  const movedTo = new Set<string>();
  for (const removedField of removed) {
    const target = added.find(
      (candidate) =>
        !movedTo.has(candidate.id) &&
        candidate.direction === removedField.direction &&
        candidate.name === removedField.name &&
        candidate.type === removedField.type,
    );
    if (!target) continue;
    movedFrom.add(removedField.id);
    movedTo.add(target.id);
    out.push(
      makeChange({
        op,
        kind: 'field_moved',
        direction: removedField.direction,
        fieldId: `${removedField.id}->${target.id}`,
        field: removedField.name,
        before: `位置 ${displayPath(removedField.id)}`,
        after: `位置 ${displayPath(target.id)}`,
        refs: target.refs,
      }),
    );
  }

  for (const field of removed) {
    if (movedFrom.has(field.id)) continue;
    out.push(
      makeChange({
        op,
        kind: 'field_removed',
        direction: field.direction,
        fieldId: field.id,
        field: displayPath(field.id),
        before: describeField(field),
        after: '已移除',
        refs: field.refs,
      }),
    );
  }
  for (const field of added) {
    if (movedTo.has(field.id)) continue;
    out.push(
      makeChange({
        op,
        kind: 'field_added',
        direction: field.direction,
        fieldId: field.id,
        field: displayPath(field.id),
        before: '不存在',
        after: describeField(field),
        refs: field.refs,
        afterRequired: field.required,
      }),
    );
  }

  // 错误码上下线
  const beforeCodes = new Set(before?.errorCodes ?? []);
  const afterCodes = new Set(after?.errorCodes ?? []);
  const beforeList = [...beforeCodes].sort().join('、');
  const afterList = [...afterCodes].sort().join('、');
  for (const code of afterCodes) {
    if (beforeCodes.has(code)) continue;
    out.push(
      makeChange({
        op,
        kind: 'error_code_added',
        direction: 'response',
        fieldId: `error.${code}`,
        field: code,
        before: `错误码集合：${beforeList || '无'}`,
        after: `新增错误码 ${code}`,
        refs: [],
      }),
    );
  }
  for (const code of beforeCodes) {
    if (afterCodes.has(code)) continue;
    out.push(
      makeChange({
        op,
        kind: 'error_code_removed',
        direction: 'response',
        fieldId: `error.${code}`,
        field: code,
        before: `错误码 ${code} 在线`,
        after: `已下线（剩余：${afterList || '无'}）`,
        refs: [],
      }),
    );
  }
}

function diffFieldType(
  op: OperationRef,
  before: ResolvedField,
  after: ResolvedField,
  out: ContractChange[],
): void {
  const relation = relateTypes(before.type, after.type);
  if (relation === 'same') return;
  out.push(
    makeChange({
      op,
      kind: relation === 'narrowed' ? 'type_narrowed' : 'type_changed',
      direction: after.direction,
      fieldId: after.id,
      field: displayPath(after.id),
      before: `类型 ${before.type}`,
      after: `类型 ${after.type}`,
      refs: after.refs,
      typeRelation: relation,
    }),
  );
}

function diffFieldRequired(
  op: OperationRef,
  before: ResolvedField,
  after: ResolvedField,
  out: ContractChange[],
): void {
  if (before.required === after.required) return;
  out.push(
    makeChange({
      op,
      kind: 'optionality_changed',
      direction: after.direction,
      fieldId: after.id,
      field: displayPath(after.id),
      before: before.required ? '必填' : '可选',
      after: after.required ? '必填' : '可选',
      refs: after.refs,
      beforeRequired: before.required,
      afterRequired: after.required,
    }),
  );
}

function diffFieldEnum(
  op: OperationRef,
  before: ResolvedField,
  after: ResolvedField,
  out: ContractChange[],
): void {
  const beforeText = before.enumValues.join(' | ') || '不限';
  const afterText = after.enumValues.join(' | ') || '不限';
  if (!before.enumValues.length && !after.enumValues.length) return;
  if (!before.enumValues.length) {
    // 值域从"不限"收缩到枚举集合
    out.push(
      makeChange({
        op,
        kind: 'enum_shrunk',
        direction: after.direction,
        fieldId: after.id,
        field: displayPath(after.id),
        before: beforeText,
        after: afterText,
        refs: after.refs,
      }),
    );
    return;
  }
  if (!after.enumValues.length) {
    // 枚举约束放开
    out.push(
      makeChange({
        op,
        kind: 'enum_expanded',
        direction: after.direction,
        fieldId: after.id,
        field: displayPath(after.id),
        before: beforeText,
        after: afterText,
        refs: after.refs,
      }),
    );
    return;
  }
  const removedValues = before.enumValues.filter((value) => !after.enumValues.includes(value));
  const addedValues = after.enumValues.filter((value) => !before.enumValues.includes(value));
  if (removedValues.length) {
    out.push(
      makeChange({
        op,
        kind: 'enum_shrunk',
        direction: after.direction,
        fieldId: after.id,
        field: displayPath(after.id),
        before: beforeText,
        after: afterText,
        refs: after.refs,
      }),
    );
  }
  if (addedValues.length) {
    out.push(
      makeChange({
        op,
        kind: 'enum_expanded',
        direction: after.direction,
        fieldId: after.id,
        field: displayPath(after.id),
        before: beforeText,
        after: afterText,
        refs: after.refs,
      }),
    );
  }
}

function makeChange(spec: ChangeSpec): ContractChange {
  const fingerprint = stableChecksum(
    [spec.op.method, spec.op.path, spec.kind, spec.direction, spec.fieldId].join('|'),
  );
  const signature = stableChecksum([fingerprint, spec.before, spec.after].join('|'));
  const classified = classifyChange({
    kind: spec.kind,
    direction: spec.direction,
    typeRelation: spec.typeRelation,
    beforeRequired: spec.beforeRequired,
    afterRequired: spec.afterRequired,
  });
  return {
    id: `chg-${fingerprint}`,
    fingerprint,
    signature,
    path: spec.op.path,
    method: spec.op.method,
    kind: spec.kind,
    direction: spec.direction,
    field: spec.field,
    refs: spec.refs,
    before: spec.before,
    after: spec.after,
    compatibility: classified.compatibility,
    rationale: classified.rationale,
    impactStatement: '',
    migrationPlan: '',
    reviewState: 'pending',
    reviewer: '',
    reviewComment: '',
  };
}

/** 类型取值范围关系：narrowed = 新类型是旧类型的真子集 */
export function relateTypes(
  before: string,
  after: string,
): 'same' | 'narrowed' | 'widened' | 'incompatible' {
  if (before === after) return 'same';
  if (before === 'any') return 'narrowed';
  if (after === 'any') return 'widened';
  if (before === 'number' && after === 'integer') return 'narrowed';
  if (before === 'integer' && after === 'number') return 'widened';
  if (after.startsWith(`${before}(`) && after.endsWith(')')) return 'narrowed';
  if (before.startsWith(`${after}(`) && before.endsWith(')')) return 'widened';
  const beforeInner = arrayInner(before);
  const afterInner = arrayInner(after);
  if (beforeInner !== null && afterInner !== null) {
    const inner = relateTypes(beforeInner, afterInner);
    return inner === 'same' ? 'incompatible' : inner;
  }
  return 'incompatible';
}

function arrayInner(signature: string): string | null {
  const match = /^array<(.+)>$/.exec(signature);
  return match ? (match[1] ?? null) : null;
}

function displayPath(fieldId: string): string {
  return fieldId.replace(/^body\./, '').replace(/^resp\./, '').replace(/^param\./, '');
}

function describeField(field: ResolvedField): string {
  const flags = [field.required ? '必填' : '可选'];
  if (field.enumValues.length) flags.push(`枚举 ${field.enumValues.join(' | ')}`);
  return `${field.name}: ${field.type}（${flags.join('，')}）`;
}

export interface MergeResult {
  changes: ContractChange[];
  added: number;
  carried: number;
  invalidated: number;
  removed: number;
}

/**
 * 把上一份差异的评审结论合并进新差异：
 * - 签名一致 → 结论、影响说明、迁移方案完整沿用
 * - 槽位相同但内容变化 → 结论失效重算，说明文字保留待按新差异确认
 * - 旧差异中消失的变化 → 连同结论一起移除
 */
export function mergeReviewState(previous: ContractChange[], next: ContractChange[]): MergeResult {
  const previousById = new Map(previous.map((change) => [change.id, change]));
  let added = 0;
  let carried = 0;
  let invalidated = 0;
  const changes = next.map((change) => {
    const old = previousById.get(change.id);
    if (!old) {
      added += 1;
      return change;
    }
    if (old.signature === change.signature) {
      carried += 1;
      return {
        ...change,
        impactStatement: old.impactStatement,
        migrationPlan: old.migrationPlan,
        reviewState: old.reviewState,
        reviewer: old.reviewer,
        reviewComment: old.reviewComment,
        reviewedAt: old.reviewedAt,
        invalidatedFrom: old.invalidatedFrom,
      };
    }
    invalidated += 1;
    return {
      ...change,
      impactStatement: old.impactStatement,
      migrationPlan: old.migrationPlan,
      reviewState: 'pending' as const,
      reviewer: '',
      reviewComment: '',
      reviewedAt: undefined,
      invalidatedFrom:
        old.reviewState !== 'pending'
          ? {
              reviewState: old.reviewState,
              reviewer: old.reviewer,
              reviewComment: old.reviewComment,
              reviewedAt: old.reviewedAt,
            }
          : old.invalidatedFrom,
    };
  });
  return {
    changes,
    added,
    carried,
    invalidated,
    removed: Math.max(previous.length - carried - invalidated, 0),
  };
}

/** 契约定义变化后，失效差异对应的豁免一并失效 */
export function refreshExemptions(
  exemptions: Exemption[],
  previous: ContractChange[],
  merged: ContractChange[],
): Exemption[] {
  const previousById = new Map(previous.map((change) => [change.id, change]));
  const mergedById = new Map(merged.map((change) => [change.id, change]));
  return exemptions.map((exemption) => {
    if (exemption.status === 'invalidated') return exemption;
    const next = mergedById.get(exemption.changeId);
    const old = previousById.get(exemption.changeId);
    if (!next) {
      return {
        ...exemption,
        status: 'invalidated' as const,
        invalidatedReason: '对应差异已不存在，豁免随旧差异失效',
      };
    }
    if (old && next.signature !== old.signature) {
      return {
        ...exemption,
        status: 'invalidated' as const,
        invalidatedReason: '契约定义变化，豁免随旧差异失效',
      };
    }
    return exemption;
  });
}
