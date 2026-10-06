import { stableChecksum } from '../lib/utils';
import type {
  ApiContract,
  ChangeKind,
  Compatibility,
  ContractChange,
  ContractVersion,
  DiffSnapshot,
  RefSnapshot,
} from '../models/contract';
import { flattenFromSource, type FieldEntry, type FlattenedDoc, type OperationEntry } from './openapi';

const EMPTY_DOC: FlattenedDoc = { operations: [], refUsage: [] };

export function changeFingerprint(
  method: string,
  path: string,
  kind: ChangeKind,
  subject: string,
): string {
  return `${method.toUpperCase()} ${path} · ${kind} · ${subject}`;
}

/** 旧数据缺少指纹时按内容兜底生成，保证迁移后身份稳定 */
export function legacyFingerprint(change: Pick<ContractChange, 'method' | 'path' | 'kind' | 'before' | 'after'>): string {
  return changeFingerprint(
    change.method,
    change.path,
    change.kind,
    `legacy-${stableChecksum(`${change.before}→${change.after}`)}`,
  );
}

export function latestFrozenVersion(contract: ApiContract): ContractVersion | undefined {
  return contract.versions.reduce<ContractVersion | undefined>((latest, version) => {
    if (!latest) return version;
    return new Date(version.releasedAt).getTime() > new Date(latest.releasedAt).getTime()
      ? version
      : latest;
  }, undefined);
}

interface ChangeSeed {
  kind: ChangeKind;
  subject: string;
  before: string;
  after: string;
  compatibility: Compatibility;
  rationale: string;
}

function makeChange(method: string, path: string, seed: ChangeSeed): ContractChange {
  const fingerprint = changeFingerprint(method, path, seed.kind, seed.subject);
  return {
    id: `chg-${stableChecksum(fingerprint)}`,
    path,
    method: method.toUpperCase(),
    kind: seed.kind,
    fingerprint,
    before: seed.before,
    after: seed.after,
    compatibility: seed.compatibility,
    rationale: seed.rationale,
    impactStatement: '',
    migrationPlan: '',
    reviewState: 'pending',
    reviewer: '',
    reviewComment: '',
  };
}

const LOCATION_LABELS: Record<FieldEntry['location'], string> = {
  request: '请求字段',
  response: '响应字段',
};

function refNote(field: FieldEntry): string {
  return field.refs.length ? `（来自共享定义 ${field.refs.join('、')}）` : '';
}

/** 纯放宽的签名变化不视为收紧：同基础类型且只删约束，或 integer 放宽为 number。 */
function isPureWidening(before: FieldEntry, after: FieldEntry): boolean {
  if (before.baseType === 'integer' && after.baseType === 'number') return true;
  if (before.baseType !== after.baseType) return false;
  const readConstraints = (signature: string): Set<string> => {
    const match = /\((.*)\)$/.exec(signature);
    if (!match) return new Set();
    return new Set(match[1].split(',').map((part) => part.split('=')[0]));
  };
  const beforeKeys = readConstraints(before.signature);
  const afterKeys = readConstraints(after.signature);
  for (const key of afterKeys) {
    if (!beforeKeys.has(key)) return false;
  }
  return beforeKeys.size > afterKeys.size;
}

function diffFieldList(
  method: string,
  path: string,
  location: FieldEntry['location'],
  baseline: FieldEntry[],
  current: FieldEntry[],
): ContractChange[] {
  const label = LOCATION_LABELS[location];
  const seeds: ChangeSeed[] = [];
  const baselineByPath = new Map(baseline.map((field) => [field.path, field]));
  const currentByPath = new Map(current.map((field) => [field.path, field]));

  const removed = baseline.filter((field) => !currentByPath.has(field.path));
  const added = current.filter((field) => !baselineByPath.has(field.path));

  // 字段移动：同名同类型的字段从一个位置换到另一个位置（含共享定义内部调整）
  const unmatchedAdded = [...added];
  const unmatchedRemoved: FieldEntry[] = [];
  for (const oldField of removed) {
    const movedIndex = unmatchedAdded.findIndex(
      (candidate) => candidate.name === oldField.name && candidate.baseType === oldField.baseType,
    );
    if (movedIndex >= 0) {
      const moved = unmatchedAdded.splice(movedIndex, 1)[0];
      seeds.push({
        kind: 'field_moved',
        subject: `${label} ${oldField.name}`,
        before: `${oldField.path}: ${oldField.signature}${refNote(oldField)}`,
        after: `移动到 ${moved.path}: ${moved.signature}${refNote(moved)}`,
        compatibility: 'breaking',
        rationale: `字段 ${oldField.name} 从 ${oldField.path} 移动到 ${moved.path}，共享定义的调整会传导到所有引用它的契约，仍读取旧位置的调用方将丢失数据。`,
      });
    } else {
      unmatchedRemoved.push(oldField);
    }
  }

  for (const field of unmatchedRemoved) {
    seeds.push({
      kind: 'field_removed',
      subject: `${label} ${field.path}`,
      before: `${field.path}: ${field.signature}${field.required ? '（必填）' : ''}${refNote(field)}`,
      after: '字段已移除',
      compatibility: 'breaking',
      rationale: '删除字段会使仍读取该字段的客户端解析失败或业务判断缺失。',
    });
  }

  for (const field of unmatchedAdded) {
    seeds.push({
      kind: 'field_added',
      subject: `${label} ${field.path}`,
      before: '字段不存在',
      after: `${field.path}: ${field.signature}${field.required ? '（必填）' : '（可选）'}${refNote(field)}`,
      compatibility: field.required ? 'breaking' : 'compatible',
      rationale: field.required
        ? '新增必填字段要求现有调用方立即修改请求。'
        : '新增可选字段不会改变现有请求和响应结构。',
    });
  }

  for (const field of current) {
    const previous = baselineByPath.get(field.path);
    if (!previous) continue;

    if (previous.required !== field.required) {
      seeds.push({
        kind: 'optionality_changed',
        subject: `${label} ${field.path}`,
        before: `${field.path} 为${previous.required ? '必填' : '可选'}字段`,
        after: `${field.path} 变为${field.required ? '必填' : '可选'}字段`,
        compatibility: field.required ? 'breaking' : 'warning',
        rationale: field.required
          ? '字段从可选变为必填，现有调用方可能不再满足请求约束。'
          : '字段从必填变为可选会改变调用方对响应完整性的假设。',
      });
    }

    const beforeEnum = previous.enumValues;
    const afterEnum = field.enumValues;
    if (beforeEnum && afterEnum) {
      const removedValues = beforeEnum.filter((value) => !afterEnum.includes(value));
      const addedValues = afterEnum.filter((value) => !beforeEnum.includes(value));
      if (removedValues.length) {
        seeds.push({
          kind: 'enum_shrunk',
          subject: `${label} ${field.path}`,
          before: `枚举 ${beforeEnum.join(' | ')}`,
          after: `移除 ${removedValues.join('、')}，剩余 ${afterEnum.join(' | ') || '空'}`,
          compatibility: 'breaking',
          rationale: '移除枚举值会使仍使用该值的调用方解析或校验失败。',
        });
      } else if (addedValues.length) {
        seeds.push({
          kind: 'enum_expanded',
          subject: `${label} ${field.path}`,
          before: `枚举 ${beforeEnum.join(' | ')}`,
          after: `新增 ${addedValues.join('、')}`,
          compatibility: 'warning',
          rationale: '新增枚举值可能使未实现默认分支的客户端出现解析或展示异常。',
        });
      }
    } else if (!beforeEnum && afterEnum) {
      seeds.push({
        kind: 'type_narrowed',
        subject: `${label} ${field.path}`,
        before: `${field.path} 取值不受枚举约束`,
        after: `限定为 ${afterEnum.join(' | ')}`,
        compatibility: 'breaking',
        rationale: '新增枚举约束后，原本合法的取值可能被拒绝。',
      });
    }

    if (previous.signature !== field.signature && !isPureWidening(previous, field)) {
      seeds.push({
        kind: 'type_narrowed',
        subject: `${label} ${field.path}`,
        before: `${field.path}: ${previous.signature}${refNote(previous)}`,
        after: `${field.path}: ${field.signature}${refNote(field)}`,
        compatibility: 'breaking',
        rationale:
          previous.baseType === field.baseType
            ? '字段约束收紧后，原本合法的取值可能被拒绝。'
            : `字段类型从 ${previous.baseType} 变为 ${field.baseType}，调用方需要确认序列化与解析逻辑。`,
      });
    }
  }

  return seeds.map((seed) => makeChange(method, path, seed));
}

function diffErrorCodes(
  method: string,
  path: string,
  baseline: string[],
  current: string[],
): ContractChange[] {
  const seeds: ChangeSeed[] = [];
  for (const code of baseline.filter((item) => !current.includes(item))) {
    seeds.push({
      kind: 'error_code_removed',
      subject: `错误码 ${code}`,
      before: `错误码集合：${baseline.join('、') || '空'}`,
      after: `下线 ${code}`,
      compatibility: 'breaking',
      rationale: '错误码下线会破坏调用方基于错误码建立的分支与重试策略。',
    });
  }
  for (const code of current.filter((item) => !baseline.includes(item))) {
    seeds.push({
      kind: 'error_code_added',
      subject: `错误码 ${code}`,
      before: `错误码集合：${baseline.join('、') || '空'}`,
      after: `新增 ${code}`,
      compatibility: 'warning',
      rationale: '调用方应明确新错误码的展示和重试策略。',
    });
  }
  return seeds.map((seed) => makeChange(method, path, seed));
}

function operationKey(operation: OperationEntry): string {
  return `${operation.method} ${operation.path}`;
}

/** 以基线文档和当前文档计算结构化差异。 */
export function diffDocs(baseline: FlattenedDoc, current: FlattenedDoc): ContractChange[] {
  const changes: ContractChange[] = [];
  const baselineOps = new Map(baseline.operations.map((op) => [operationKey(op), op]));
  const currentOps = new Map(current.operations.map((op) => [operationKey(op), op]));

  for (const operation of current.operations) {
    const previous = baselineOps.get(operationKey(operation));
    if (!previous) {
      changes.push(
        ...diffFieldList(operation.method, operation.path, 'request', [], operation.requestFields),
        ...diffFieldList(operation.method, operation.path, 'response', [], operation.responseFields),
        ...diffErrorCodes(operation.method, operation.path, [], operation.errorCodes),
      );
      continue;
    }
    changes.push(
      ...diffFieldList(
        operation.method,
        operation.path,
        'request',
        previous.requestFields,
        operation.requestFields,
      ),
      ...diffFieldList(
        operation.method,
        operation.path,
        'response',
        previous.responseFields,
        operation.responseFields,
      ),
      ...diffErrorCodes(operation.method, operation.path, previous.errorCodes, operation.errorCodes),
    );
  }

  for (const operation of baseline.operations) {
    if (currentOps.has(operationKey(operation))) continue;
    changes.push(
      ...diffFieldList(operation.method, operation.path, 'request', operation.requestFields, []),
      ...diffFieldList(operation.method, operation.path, 'response', operation.responseFields, []),
      ...diffErrorCodes(operation.method, operation.path, operation.errorCodes, []),
    );
  }

  return changes.sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
}

export interface ComputedDiff {
  changes: ContractChange[];
  snapshot: DiffSnapshot;
  refSnapshot: RefSnapshot;
}

/**
 * 以最近冻结版本为基线展开引用并计算差异。
 * 解析失败或引用成环时抛错，由调用方决定保留旧快照。
 */
export function computeDiffSnapshot(
  contract: ApiContract,
  openapi: string,
  now: string,
): ComputedDiff {
  const sourceChecksum = stableChecksum(openapi);
  const current = flattenFromSource(openapi);

  const baseline = latestFrozenVersion(contract);
  let baselineDoc = EMPTY_DOC;
  let baselineChecksum: string | null = null;
  if (baseline) {
    baselineChecksum = baseline.checksum || stableChecksum(baseline.openapi);
    try {
      baselineDoc = flattenFromSource(baseline.openapi);
    } catch {
      // 基线快照损坏时退化为空基线，不阻断当前定义的计算
      baselineDoc = EMPTY_DOC;
    }
  }

  // 没有冻结基线时不产生差异，版本链从首次冻结开始
  const changes = baseline ? diffDocs(baselineDoc, current) : [];

  return {
    changes,
    snapshot: {
      id: `snap-${stableChecksum(`${contract.id}:${sourceChecksum}`)}`,
      baselineVersion: baseline?.version ?? null,
      baselineChecksum,
      sourceChecksum,
      computedAt: now,
      changeCount: changes.length,
      changes,
    },
    refSnapshot: {
      sourceChecksum,
      resolvedAt: now,
      status: 'ok',
      refs: current.refUsage,
    },
  };
}

function mergePreservingReview(computed: ContractChange[], previous: ContractChange[]): ContractChange[] {
  const previousByFingerprint = new Map(previous.map((change) => [change.fingerprint, change]));
  return computed.map((change) => {
    const old = previousByFingerprint.get(change.fingerprint);
    if (!old) return change;
    return {
      ...change,
      impactStatement: old.impactStatement,
      migrationPlan: old.migrationPlan,
      reviewState: old.reviewState,
      reviewer: old.reviewer,
      reviewComment: old.reviewComment,
      reviewedAt: old.reviewedAt,
      impactStale: old.impactStale,
    };
  });
}

/** 定义变化后：旧评审结论与豁免失效，影响说明保留原文但需按新差异确认 */
function mergeInvalidatingReview(
  computed: ContractChange[],
  previous: ContractChange[],
): ContractChange[] {
  const previousByFingerprint = new Map(previous.map((change) => [change.fingerprint, change]));
  return computed.map((change) => {
    const old = previousByFingerprint.get(change.fingerprint);
    if (!old) return change;
    return {
      ...change,
      impactStatement: old.impactStatement,
      migrationPlan: old.migrationPlan,
      impactStale: change.compatibility !== 'compatible',
      invalidatedReason: '契约定义已变化，旧评审结论失效，需按新差异重新确认',
      reviewState: 'pending',
      reviewer: old.reviewer,
      reviewComment: old.reviewComment,
    };
  });
}

/**
 * 导入新版本定义：解析 → 展开引用 → 以最近冻结版本为基线计算差异 → 失效重算。
 * 重复导入同一定义不产生第二份差异；解析失败或引用成环时保留上一份有效差异。
 */
export function recomputeContractDefinition(
  contract: ApiContract,
  openapi: string,
  now: string,
): ApiContract {
  const sourceChecksum = stableChecksum(openapi);

  // 幂等：定义未变化时不重算、不新增差异；保存动作同时确认回填的引用快照
  if (contract.diffSnapshot?.sourceChecksum === sourceChecksum && !contract.definitionError) {
    return {
      ...contract,
      openapi,
      refSnapshot: contract.refSnapshot
        ? { ...contract.refSnapshot, status: 'ok' }
        : contract.refSnapshot,
    };
  }

  try {
    const computed = computeDiffSnapshot(contract, openapi, now);
    const definitionChanged = contract.diffSnapshot
      ? contract.diffSnapshot.sourceChecksum !== sourceChecksum
      : false;
    const changes = definitionChanged
      ? mergeInvalidatingReview(computed.changes, contract.changes)
      : mergePreservingReview(computed.changes, contract.changes);
    const exemptions = definitionChanged
      ? contract.exemptions.map((item) =>
          item.invalidatedAt ? item : { ...item, invalidatedAt: now },
        )
      : contract.exemptions;

    return {
      ...contract,
      openapi,
      changes,
      exemptions,
      diffSnapshot: { ...computed.snapshot, changes },
      refSnapshot: computed.refSnapshot,
      definitionError: null,
    };
  } catch (error) {
    // 引用成环或文档坏掉：从完整差异快照恢复，保留上一份有效差异
    const restored = contract.diffSnapshot?.changes ?? contract.changes;
    return {
      ...contract,
      openapi,
      changes: restored,
      definitionError: {
        message: error instanceof Error ? error.message : '接口定义无法解析',
        occurredAt: now,
      },
    };
  }
}

/**
 * 旧数据迁移：缺少差异/引用快照的契约按当前定义回填，
 * 引用快照标记为 backfilled（待核），不覆盖既有评审结论。
 */
export function backfillContractSnapshot(contract: ApiContract): ApiContract {
  let next = contract;
  const ensure = (patch: Partial<ApiContract>): void => {
    next = { ...next, ...patch };
  };

  if (!Array.isArray(next.exemptions)) ensure({ exemptions: [] });
  if (!Array.isArray(next.versions)) ensure({ versions: [] });
  if (!Array.isArray(next.consumers)) ensure({ consumers: [] });
  if (!Array.isArray(next.changes)) ensure({ changes: [] });

  if (next.changes.some((change) => !change.fingerprint)) {
    ensure({
      changes: next.changes.map((change) =>
        change.fingerprint ? change : { ...change, fingerprint: legacyFingerprint(change) },
      ),
    });
  }

  const sourceChecksum = stableChecksum(next.openapi ?? '');

  if (!next.diffSnapshot) {
    const baseline = latestFrozenVersion(next);
    ensure({
      diffSnapshot: {
        id: `snap-${stableChecksum(`${next.id}:${sourceChecksum}`)}`,
        baselineVersion: baseline?.version ?? null,
        baselineChecksum: baseline?.checksum ?? null,
        sourceChecksum,
        computedAt: next.updatedAt,
        changeCount: next.changes.length,
        changes: next.changes,
      },
    });
  }

  if (!next.refSnapshot) {
    let refs: RefSnapshot['refs'] = [];
    let definitionError = next.definitionError ?? null;
    try {
      refs = flattenFromSource(next.openapi).refUsage;
    } catch (error) {
      definitionError = {
        message: error instanceof Error ? error.message : '接口定义无法解析',
        occurredAt: next.updatedAt,
      };
    }
    ensure({
      refSnapshot: {
        sourceChecksum,
        resolvedAt: next.updatedAt,
        status: 'backfilled',
        refs,
      },
      definitionError,
    });
  }

  return next;
}
