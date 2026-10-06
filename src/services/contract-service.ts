import { seedContracts } from '../data/seed';
import type {
  ApiContract,
  ContractChange,
  ContractVersion,
  DiffSnapshot,
  Exemption,
  ImportRecord,
  ReviewState,
} from '../models/contract';
import { diffSnapshots, mergeReviewState, refreshExemptions } from '../models/diff';
import {
  buildReferenceSnapshot,
  parseOpenApiDocument,
  type ReferenceSnapshot,
  type SnapshotWarning,
} from '../models/openapi';
import { stableChecksum, formatDateTime } from '../lib/utils';

const STORAGE_KEY = 'pair-wise-gsb-70-contracts';
const LATENCY = 180;

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function wait(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, LATENCY));
}

export async function listContracts(): Promise<ApiContract[]> {
  await wait();
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as Array<Record<string, unknown>>;
      let migratedAny = false;
      const contracts = parsed.map((raw) => {
        const { contract, migrated } = migrateContract(raw);
        migratedAny = migratedAny || migrated;
        return contract;
      });
      if (migratedAny) {
        persistContracts(contracts);
      }
      return contracts;
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }
  persistContracts(seedContracts);
  return clone(seedContracts);
}

export async function getContract(id: string): Promise<ApiContract | undefined> {
  const contracts = await listContracts();
  return contracts.find((contract) => contract.id === id);
}

export type ApplyOutcome =
  | {
      type: 'computed';
      added: number;
      carried: number;
      invalidated: number;
      removed: number;
      baselineVersion: string;
    }
  | { type: 'duplicate' }
  | { type: 'kept-last-valid'; reason: string; warnings: SnapshotWarning[] };

export interface ApplyResult {
  contract: ApiContract;
  outcome: ApplyOutcome;
}

/**
 * 导入/保存接口定义：解析 → 展开引用 → 以最近冻结版本为基线计算差异 → 合并评审结论。
 *
 * - 引用成环或文档损坏：不写入任何状态，保留上一份有效差异（kept-last-valid）
 * - 重复导入同值定义：不产生第二份差异（duplicate）
 * - 定义变化：旧评审结论与豁免失效重算，调用方说明保留待按新差异确认
 */
export async function applyContractDefinition(
  contractId: string,
  source: string,
): Promise<ApplyResult> {
  const contracts = await listContracts();
  const contract = contracts.find((item) => item.id === contractId);
  if (!contract) {
    throw new Error('契约不存在');
  }
  const now = new Date().toISOString();

  const built = buildReferenceSnapshot(source);
  if (!built.ok) {
    const record: ImportRecord = {
      at: now,
      outcome: 'kept-last-valid',
      detail: built.error,
      warnings: built.warnings,
    };
    const kept: ApiContract = { ...contract, lastImport: record, updatedAt: now };
    persistContracts(contracts.map((item) => (item.id === contractId ? kept : item)));
    await wait();
    return {
      contract: clone(kept),
      outcome: { type: 'kept-last-valid', reason: built.error, warnings: built.warnings },
    };
  }
  const snapshot = built.snapshot;

  if (contract.diff && contract.diff.status === 'ok' && contract.diff.sourceChecksum === snapshot.checksum) {
    const record: ImportRecord = {
      at: now,
      outcome: 'duplicate',
      detail: '导入定义与当前工作副本一致，未产生第二份差异。',
      warnings: [],
    };
    const kept: ApiContract = { ...contract, lastImport: record, updatedAt: now };
    persistContracts(contracts.map((item) => (item.id === contractId ? kept : item)));
    await wait();
    return { contract: clone(kept), outcome: { type: 'duplicate' } };
  }

  const baseline = contract.versions[0] ?? null;
  const baselineSnapshot = baseline ? resolveVersionSnapshot(baseline) : null;
  const warnings: SnapshotWarning[] = [];
  if (baseline && !baselineSnapshot) {
    warnings.push({
      kind: 'baseline_missing',
      ref: baseline.version,
      detail: `基线版本 v${baseline.version} 的定义无法解析，本次差异按空基线计算`,
    });
  }

  const computed = diffSnapshots(baselineSnapshot, snapshot);
  const previous = contract.diff?.changes ?? [];
  const merged = mergeReviewState(previous, computed);
  const diff: DiffSnapshot = {
    id: `diff-${Date.now()}`,
    baselineVersionId: baseline?.id ?? null,
    baselineVersion: baseline?.version ?? '',
    sourceChecksum: snapshot.checksum,
    computedAt: now,
    status: 'ok',
    backfilled: false,
    warnings,
    changes: merged.changes,
  };
  const detail = baseline
    ? `按基线 v${baseline.version} 重算差异：新增 ${merged.added} 项、沿用 ${merged.carried} 项、失效重算 ${merged.invalidated} 项、移除 ${merged.removed} 项。`
    : '尚无冻结基线，首次冻结后开始跟踪差异。';
  const updated: ApiContract = {
    ...contract,
    openapi: source,
    currentSnapshot: snapshot,
    diff,
    exemptions: refreshExemptions(contract.exemptions, previous, merged.changes),
    status: merged.changes.length ? 'review' : contract.status,
    lastImport: { at: now, outcome: 'computed', detail, warnings },
    updatedAt: now,
  };
  persistContracts(contracts.map((item) => (item.id === contractId ? updated : item)));
  await wait();
  return {
    contract: clone(updated),
    outcome: {
      type: 'computed',
      added: merged.added,
      carried: merged.carried,
      invalidated: merged.invalidated,
      removed: merged.removed,
      baselineVersion: baseline?.version ?? '',
    },
  };
}

export interface ImportDocumentResult {
  contract: ApiContract;
  outcome: ApplyOutcome | { type: 'created' };
}

/**
 * 工作台导入：info.title 命中已有契约时按新版本导入并重算差异，
 * 否则创建契约草稿。解析失败时不写入任何状态。
 */
export async function importContractDocument(source: string): Promise<ImportDocumentResult> {
  const parsed = parseOpenApiDocument(source);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  const contracts = await listContracts();
  const existing = contracts.find((contract) => contract.name === parsed.doc.title);
  if (existing) {
    return applyContractDefinition(existing.id, source);
  }
  const built = buildReferenceSnapshot(source);
  if (!built.ok) {
    throw new Error(built.error);
  }
  const now = new Date().toISOString();
  const contract: ApiContract = {
    id: `contract-${Date.now()}`,
    name: parsed.doc.title,
    version: parsed.doc.version || '0.1.0',
    domain: '待分类',
    owner: '当前用户',
    protocol: 'REST',
    status: 'draft',
    updatedAt: now,
    openapi: source,
    currentSnapshot: built.snapshot,
    diff: {
      id: `diff-${Date.now()}`,
      baselineVersionId: null,
      baselineVersion: '',
      sourceChecksum: built.snapshot.checksum,
      computedAt: now,
      status: 'ok',
      backfilled: false,
      warnings: [],
      changes: [],
    },
    consumers: [],
    exemptions: [],
    versions: [],
    lastImport: {
      at: now,
      outcome: 'computed',
      detail: '首次导入，尚无冻结基线，冻结后开始跟踪差异。',
      warnings: [],
    },
  };
  persistContracts([contract, ...contracts]);
  await wait();
  return { contract: clone(contract), outcome: { type: 'created' } };
}

export async function reviewChange(
  contractId: string,
  changeId: string,
  reviewState: ReviewState,
  reviewer: string,
  comment: string,
): Promise<ApiContract> {
  const contracts = await listContracts();
  const contract = contracts.find((item) => item.id === contractId);
  if (!contract) {
    throw new Error('契约不存在');
  }
  if (!contract.diff) {
    throw new Error('契约缺少差异快照');
  }

  const updated: ApiContract = {
    ...contract,
    status: contract.status === 'draft' ? 'review' : contract.status,
    diff: {
      ...contract.diff,
      changes: contract.diff.changes.map((change) =>
        change.id === changeId
          ? {
              ...change,
              reviewState,
              reviewer,
              reviewComment: comment,
              reviewedAt: new Date().toISOString(),
            }
          : change,
      ),
    },
  };
  persistContracts(contracts.map((item) => (item.id === contractId ? updated : item)));
  await wait();
  return clone(updated);
}

export async function bulkReviewChanges(
  selections: Array<{ contractId: string; changeId: string }>,
  reviewState: ReviewState,
  reviewer: string,
  comment: string,
): Promise<ApiContract[]> {
  const contracts = await listContracts();
  const selected = new Set(selections.map((item) => `${item.contractId}:${item.changeId}`));
  const now = new Date().toISOString();
  const updated = contracts.map((contract) => {
    if (!contract.diff) return contract;
    const touched = contract.diff.changes.some((change) =>
      selected.has(`${contract.id}:${change.id}`),
    );
    if (!touched) return contract;
    return {
      ...contract,
      status: contract.status === 'draft' ? ('review' as const) : contract.status,
      diff: {
        ...contract.diff,
        changes: contract.diff.changes.map((change) =>
          selected.has(`${contract.id}:${change.id}`)
            ? { ...change, reviewState, reviewer, reviewComment: comment, reviewedAt: now }
            : change,
        ),
      },
    };
  });
  persistContracts(updated);
  await wait();
  return clone(updated);
}

export async function updateChangeStatements(
  contractId: string,
  changeId: string,
  patch: Partial<Pick<ContractChange, 'impactStatement' | 'migrationPlan'>>,
): Promise<ApiContract> {
  const contracts = await listContracts();
  const contract = contracts.find((item) => item.id === contractId);
  if (!contract) {
    throw new Error('契约不存在');
  }
  if (!contract.diff) {
    throw new Error('契约缺少差异快照');
  }
  const updated: ApiContract = {
    ...contract,
    updatedAt: new Date().toISOString(),
    diff: {
      ...contract.diff,
      changes: contract.diff.changes.map((change) =>
        change.id === changeId ? { ...change, ...patch } : change,
      ),
    },
  };
  persistContracts(contracts.map((item) => (item.id === contractId ? updated : item)));
  await wait();
  return clone(updated);
}

/** 旧数据回填的差异快照经人工核对后标记为有效 */
export async function confirmDiffSnapshot(contractId: string): Promise<ApiContract> {
  const contracts = await listContracts();
  const contract = contracts.find((item) => item.id === contractId);
  if (!contract) {
    throw new Error('契约不存在');
  }
  if (!contract.diff) {
    throw new Error('契约缺少差异快照');
  }
  const updated: ApiContract = {
    ...contract,
    updatedAt: new Date().toISOString(),
    diff: {
      ...contract.diff,
      status: 'ok',
      confirmedBy: '当前评审人',
      confirmedAt: new Date().toISOString(),
    },
  };
  persistContracts(contracts.map((item) => (item.id === contractId ? updated : item)));
  await wait();
  return clone(updated);
}

export async function addExemption(
  contractId: string,
  changeId: string,
  reason: string,
): Promise<ApiContract> {
  const contracts = await listContracts();
  const contract = contracts.find((item) => item.id === contractId);
  if (!contract) {
    throw new Error('契约不存在');
  }
  if (!contract.diff) {
    throw new Error('契约缺少差异快照');
  }
  const exemption: Exemption = {
    id: `ex-${Date.now()}`,
    changeId,
    scope: contract.diff.changes.find((item) => item.id === changeId)?.path ?? '未指定',
    reason,
    approvedBy: '当前评审人',
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    status: 'active',
  };
  const updated: ApiContract = {
    ...contract,
    exemptions: [...contract.exemptions, exemption],
    diff: {
      ...contract.diff,
      changes: contract.diff.changes.map((change) =>
        change.id === changeId ? { ...change, reviewState: 'exemption' } : change,
      ),
    },
  };
  persistContracts(contracts.map((item) => (item.id === contractId ? updated : item)));
  await wait();
  return clone(updated);
}

/**
 * 冻结正式版本：归档当前差异与引用快照，并把差异基线推进到新版本，
 * 后续导入以该版本为基线继续版本链。
 */
export async function freezeVersion(
  contractId: string,
  version: string,
  notes: string,
): Promise<ApiContract> {
  const contracts = await listContracts();
  const contract = contracts.find((item) => item.id === contractId);
  if (!contract) {
    throw new Error('契约不存在');
  }
  const now = new Date().toISOString();
  const diff = contract.diff;
  const release: ContractVersion = {
    id: `ver-${Date.now()}`,
    contractId,
    version,
    releasedAt: now,
    checksum: diff?.sourceChecksum ?? stableChecksum(contract.openapi),
    notes,
    changeIds: diff?.changes.map((change) => change.id) ?? [],
    changes: diff?.changes ?? [],
    diffId: diff?.id ?? '',
    openapi: contract.openapi,
    snapshot: contract.currentSnapshot,
  };
  const nextDiff: DiffSnapshot = {
    id: `diff-${Date.now()}`,
    baselineVersionId: release.id,
    baselineVersion: version,
    sourceChecksum: release.checksum,
    computedAt: now,
    status: 'ok',
    backfilled: false,
    warnings: [],
    changes: [],
  };
  const updated: ApiContract = {
    ...contract,
    version,
    status: 'frozen',
    versions: [release, ...contract.versions],
    diff: nextDiff,
    updatedAt: now,
  };
  persistContracts(contracts.map((item) => (item.id === contractId ? updated : item)));
  await wait();
  return clone(updated);
}

export function generateExampleRequest(contract: ApiContract, change?: ContractChange): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contract.openapi);
  } catch {
    parsed = null;
  }
  const openapi = parsed as
    | {
        paths?: Record<string, Record<string, { summary?: string }>>;
      }
    | null;
  const candidates = openapi?.paths ? Object.entries(openapi.paths) : [];
  const selectedPath = change?.path ?? candidates[0]?.[0] ?? '/resource';
  const selectedMethod = (
    change?.method ??
    (candidates[0]?.[1] ? Object.keys(candidates[0][1])[0] : 'get')
  ).toUpperCase();
  const fields = change
    ? [change.after.replace(/^新增|移除|变为/g, '').trim()]
    : ['orderId: ORD-20260929-001', 'requestId: req-local-demo'];

  return JSON.stringify(
    {
      method: selectedMethod,
      url: `https://api.example.com${selectedPath.replace('{orderId}', 'ORD-20260929-001').replace('{paymentId}', 'PAY-90218').replace('{userId}', 'U-1024')}`,
      headers: {
        Authorization: 'Bearer <token>',
        'X-Client-Version': contract.version,
      },
      body:
        selectedMethod === 'GET'
          ? undefined
          : Object.fromEntries(
              fields.map((field) => {
                const [key, value] = field.split(':').map((item) => item.trim());
                return [key || 'field', value || 'value'];
              }),
            ),
    },
    null,
    2,
  );
}

export function buildChangeReport(contract: ApiContract): string {
  const diff = contract.diff;
  const changes = diff?.changes ?? [];
  const lines = [
    `# ${contract.name} ${contract.version} 契约变更报告`,
    '',
    `- 领域：${contract.domain}`,
    `- 负责人：${contract.owner}`,
    `- 状态：${contract.status}`,
    `- 生成时间：${new Date().toISOString()}`,
    '',
    '## 版本链',
    `- 差异基线：${diff?.baselineVersion ? `v${diff.baselineVersion}` : '无（首个版本）'}`,
    `- 工作副本校验值：${diff?.sourceChecksum ?? '未知'}`,
    `- 快照状态：${
      diff
        ? diff.status === 'stale'
          ? `待核对（旧数据回填${diff.confirmedBy ? '' : '，未确认'}）`
          : '有效'
        : '缺失'
    }`,
    `- 差异计算时间：${diff ? formatDateTime(diff.computedAt) : '未知'}`,
    '',
    '## 变更明细',
    ...changes.flatMap((change) => [
      `### ${change.method} ${change.path} - ${change.kind}`,
      `- 方向：${change.direction === 'request' ? '请求' : '响应'} · 字段：${change.field}`,
      `- 兼容性：${change.compatibility}`,
      `- 变更前：${change.before}`,
      `- 变更后：${change.after}`,
      ...(change.refs.length ? [`- 引用链：${change.refs.join(' → ')}`] : []),
      `- 判定依据：${change.rationale}`,
      `- 调用方影响：${change.impactStatement || '未填写'}`,
      `- 迁移方案：${change.migrationPlan || '未填写'}`,
      `- 评审结论：${change.reviewState}`,
      ...(change.invalidatedFrom
        ? [
            `- 已失效旧结论：${change.invalidatedFrom.reviewState}（${change.invalidatedFrom.reviewer}：${change.invalidatedFrom.reviewComment}）`,
          ]
        : []),
      '',
    ]),
    '## 调用方',
    ...contract.consumers.map(
      (consumer) =>
        `- ${consumer.name} / ${consumer.owner} / ${consumer.environment} / ${consumer.clientVersion}`,
    ),
    '',
    '## 豁免记录',
    ...(contract.exemptions.length
      ? contract.exemptions.map(
          (item) =>
            `- ${item.scope}：${item.reason}（至 ${item.expiresAt}）${
              item.status === 'invalidated' ? `【已失效：${item.invalidatedReason ?? ''}】` : ''
            }`,
        )
      : ['- 无']),
  ];
  return lines.join('\n');
}

export function diffVersionSummary(contract: ApiContract): string {
  const baseline = contract.versions[0];
  if (!baseline) {
    return '尚无冻结基线，首次冻结后开始跟踪差异。';
  }
  return [
    `基线版本 v${baseline.version}`,
    `冻结于 ${formatDateTime(baseline.releasedAt)}`,
    `校验值 ${baseline.checksum}`,
    `当前差异 ${contract.diff?.changes.length ?? 0} 项`,
  ].join('\n');
}

function persistContracts(contracts: ApiContract[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(contracts));
}

/** 冻结版本缺少引用快照时按存档定义现算 */
function resolveVersionSnapshot(version: ContractVersion): ReferenceSnapshot | null {
  if (version.snapshot) return version.snapshot;
  const built = buildReferenceSnapshot(version.openapi);
  return built.ok ? built.snapshot : null;
}

interface MigrationResult {
  contract: ApiContract;
  migrated: boolean;
}

/**
 * 旧数据迁移：
 * - 缺少引用快照与差异快照的契约，按当前定义回填并标成待核（stale）
 * - 冻结版本补充引用快照
 * - 豁免补充生效状态
 */
function migrateContract(raw: Record<string, unknown>): MigrationResult {
  const legacy = raw as unknown as ApiContract & { changes?: Array<Record<string, unknown>> };
  let migrated = false;

  const exemptions: Exemption[] = (legacy.exemptions ?? []).map((exemption) => {
    if (exemption.status) return exemption;
    migrated = true;
    return { ...exemption, status: 'active' as const };
  });

  const versions: ContractVersion[] = (legacy.versions ?? []).map((version) => {
    if (version.snapshot !== undefined && version.changes !== undefined) return version;
    migrated = true;
    const built = buildReferenceSnapshot(version.openapi);
    return {
      ...version,
      changes: version.changes ?? [],
      diffId: version.diffId ?? '',
      snapshot: built.ok ? built.snapshot : null,
    };
  });

  let diff = legacy.diff ?? null;
  let currentSnapshot = legacy.currentSnapshot ?? null;
  if (!diff) {
    migrated = true;
    const built = buildReferenceSnapshot(legacy.openapi);
    currentSnapshot = built.ok ? built.snapshot : null;
    diff = {
      id: `diff-${legacy.id}-backfill`,
      baselineVersionId: versions[0]?.id ?? null,
      baselineVersion: versions[0]?.version ?? '',
      sourceChecksum: built.ok ? built.snapshot.checksum : stableChecksum(legacy.openapi),
      computedAt: new Date().toISOString(),
      status: 'stale',
      backfilled: true,
      warnings: built.ok ? [] : built.warnings,
      changes: (legacy.changes ?? []).map(upgradeLegacyChange),
    };
  }

  const contract: ApiContract = {
    ...legacy,
    consumers: legacy.consumers ?? [],
    exemptions,
    versions,
    diff,
    currentSnapshot,
  };
  delete (contract as { changes?: unknown }).changes;
  return { contract, migrated };
}

function upgradeLegacyChange(change: Record<string, unknown>): ContractChange {
  const legacy = change as Partial<ContractChange> &
    Pick<ContractChange, 'id' | 'path' | 'method' | 'kind' | 'before' | 'after'>;
  const fingerprint =
    legacy.fingerprint ??
    stableChecksum([legacy.method, legacy.path, legacy.kind, legacy.before].join('|'));
  return {
    id: legacy.id,
    fingerprint,
    signature:
      legacy.signature ?? stableChecksum([fingerprint, legacy.before, legacy.after].join('|')),
    path: legacy.path,
    method: legacy.method,
    kind: legacy.kind,
    direction: legacy.direction ?? 'response',
    field: legacy.field ?? '',
    refs: legacy.refs ?? [],
    before: legacy.before,
    after: legacy.after,
    compatibility: legacy.compatibility ?? 'warning',
    rationale: legacy.rationale ?? '',
    impactStatement: legacy.impactStatement ?? '',
    migrationPlan: legacy.migrationPlan ?? '',
    reviewState: legacy.reviewState ?? 'pending',
    reviewer: legacy.reviewer ?? '',
    reviewComment: legacy.reviewComment ?? '',
    reviewedAt: legacy.reviewedAt,
    invalidatedFrom: legacy.invalidatedFrom,
  };
}
