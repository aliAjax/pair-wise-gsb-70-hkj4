import { seedContracts } from '../data/seed';
import type {
  ApiContract,
  ContractChange,
  ContractVersion,
  ReviewState,
} from '../models/contract';
import { stableChecksum, formatDateTime } from '../lib/utils';
import { backfillContractSnapshot, recomputeContractDefinition } from './diff-engine';

const STORAGE_KEY = 'pair-wise-gsb-70-contracts';
const LATENCY = 180;

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function wait(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, LATENCY));
}

/** 评审结论、影响说明等用户标注同步进差异快照，保证失败恢复时不丢失 */
function withSyncedSnapshot(contract: ApiContract): ApiContract {
  if (!contract.diffSnapshot) return contract;
  return {
    ...contract,
    diffSnapshot: {
      ...contract.diffSnapshot,
      changes: contract.changes,
      changeCount: contract.changes.length,
    },
  };
}

export async function listContracts(): Promise<ApiContract[]> {
  await wait();
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as ApiContract[];
      // 旧数据缺少引用/差异快照时按当前定义回填，并标记为待核
      const migrated = parsed.map((contract) => backfillContractSnapshot(contract));
      if (migrated.some((contract, index) => contract !== parsed[index])) {
        persistContracts(migrated);
      }
      return migrated;
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

export async function saveContract(updated: ApiContract): Promise<ApiContract> {
  const contracts = await listContracts();
  const exists = contracts.some((contract) => contract.id === updated.id);
  const saved = withSyncedSnapshot({ ...updated, updatedAt: new Date().toISOString() });
  const next = exists
    ? contracts.map((contract) => (contract.id === updated.id ? saved : contract))
    : [saved, ...contracts];
  persistContracts(next);
  await wait();
  return clone(saved);
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

  const updated: ApiContract = withSyncedSnapshot({
    ...contract,
    status: contract.status === 'draft' ? 'review' : contract.status,
    changes: contract.changes.map((change) =>
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
  });
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
  const updated = contracts.map((contract) =>
    withSyncedSnapshot({
      ...contract,
      status:
        selected.has(`${contract.id}:${contract.changes[0]?.id}`) && contract.status === 'draft'
          ? ('review' as const)
          : contract.status,
      changes: contract.changes.map((change) =>
        selected.has(`${contract.id}:${change.id}`)
          ? {
              ...change,
              reviewState,
              reviewer,
              reviewComment: comment,
              reviewedAt: new Date().toISOString(),
            }
          : change,
      ),
    }),
  );
  persistContracts(updated);
  await wait();
  return clone(updated);
}

export async function updateContractOpenApi(
  contractId: string,
  openapi: string,
): Promise<ApiContract> {
  const contracts = await listContracts();
  const contract = contracts.find((item) => item.id === contractId);
  if (!contract) {
    throw new Error('契约不存在');
  }
  // 导入新版本定义：解析 → 展开引用 → 按冻结基线重算差异；
  // 失败时从完整差异快照恢复，重复导入不产生第二份差异
  const now = new Date().toISOString();
  const updated = { ...recomputeContractDefinition(contract, openapi, now), updatedAt: now };
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
  const exemption = {
    id: `ex-${Date.now()}`,
    changeId,
    scope: contract.changes.find((item) => item.id === changeId)?.path ?? '未指定',
    reason,
    approvedBy: '当前评审人',
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  };
  const updated: ApiContract = withSyncedSnapshot({
    ...contract,
    exemptions: [...contract.exemptions, exemption],
    changes: contract.changes.map((change) =>
      change.id === changeId ? { ...change, reviewState: 'exemption' } : change,
    ),
  });
  persistContracts(contracts.map((item) => (item.id === contractId ? updated : item)));
  await wait();
  return clone(updated);
}

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

  const release: ContractVersion = {
    id: `ver-${Date.now()}`,
    contractId,
    version,
    releasedAt: new Date().toISOString(),
    checksum: stableChecksum(contract.openapi),
    notes,
    changeIds: contract.changes.map((change) => change.id),
    openapi: contract.openapi,
    // 冻结时把完整差异快照挂上版本链，作为后续导入的基线
    diffSnapshot: contract.diffSnapshot,
  };
  const updated: ApiContract = {
    ...contract,
    version,
    status: 'frozen',
    versions: [release, ...contract.versions],
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
  const snapshot = contract.diffSnapshot;
  const refSnapshot = contract.refSnapshot;
  const lines = [
    `# ${contract.name} ${contract.version} 契约变更报告`,
    '',
    `- 领域：${contract.domain}`,
    `- 负责人：${contract.owner}`,
    `- 状态：${contract.status}`,
    `- 差异基线：${snapshot?.baselineVersion ? `v${snapshot.baselineVersion}（${snapshot.baselineChecksum ?? '无校验值'}）` : '无冻结基线'}`,
    `- 定义校验值：${snapshot?.sourceChecksum ?? '未计算'}`,
    `- 引用快照：${
      refSnapshot
        ? refSnapshot.status === 'backfilled'
          ? `回填待核（${refSnapshot.refs.length} 个共享定义）`
          : `已确认（${refSnapshot.refs.length} 个共享定义）`
        : '缺失'
    }`,
    ...(contract.definitionError ? [`- 定义异常：${contract.definitionError.message}`] : []),
    `- 生成时间：${new Date().toISOString()}`,
    '',
    '## 变更明细',
    ...contract.changes.flatMap((change) => [
      `### ${change.method} ${change.path} - ${change.kind}`,
      `- 兼容性：${change.compatibility}`,
      `- 变更前：${change.before}`,
      `- 变更后：${change.after}`,
      `- 判定依据：${change.rationale}`,
      `- 调用方影响：${change.impactStatement || '未填写'}${change.impactStale ? '（待按新差异确认）' : ''}`,
      `- 迁移方案：${change.migrationPlan || '未填写'}`,
      `- 评审结论：${change.reviewState}`,
      ...(change.invalidatedReason ? [`- 失效说明：${change.invalidatedReason}`] : []),
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
            `- ${item.scope}：${item.reason}（至 ${item.expiresAt}）${item.invalidatedAt ? '【已失效，需按新差异重新登记】' : ''}`,
        )
      : ['- 无']),
  ];
  return lines.join('\n');
}

export function diffVersionSummary(contract: ApiContract): string {
  const snapshot = contract.diffSnapshot;
  if (!snapshot) {
    return '尚无差异快照，保存接口定义后生成。';
  }
  return [
    snapshot.baselineVersion
      ? `基线版本 v${snapshot.baselineVersion}（${snapshot.baselineChecksum ?? '无校验值'}）`
      : '无冻结基线，差异从首次冻结后开始计算',
    `当前定义校验 ${snapshot.sourceChecksum}`,
    `差异 ${snapshot.changeCount} 项 · 计算于 ${formatDateTime(snapshot.computedAt)}`,
  ].join('\n');
}

function persistContracts(contracts: ApiContract[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(contracts));
}
