export type ContractStatus = 'draft' | 'review' | 'ready' | 'released' | 'frozen';
export type ChangeKind =
  | 'field_added'
  | 'field_removed'
  | 'field_moved'
  | 'type_narrowed'
  | 'optionality_changed'
  | 'enum_expanded'
  | 'enum_shrunk'
  | 'error_code_added'
  | 'error_code_removed';
export type Compatibility = 'compatible' | 'warning' | 'breaking';
export type ReviewState = 'pending' | 'accepted' | 'returned' | 'exemption';

export interface ContractChange {
  id: string;
  path: string;
  method: string;
  kind: ChangeKind;
  /** 差异指纹：方法 + 路径 + 类型 + 对象，用于跨次计算对齐同一条差异 */
  fingerprint: string;
  before: string;
  after: string;
  compatibility: Compatibility;
  rationale: string;
  impactStatement: string;
  migrationPlan: string;
  /** 定义变化后影响说明写于旧差异，需按新差异重新确认 */
  impactStale?: boolean;
  /** 定义变化导致旧评审结论失效的原因说明 */
  invalidatedReason?: string;
  reviewState: ReviewState;
  reviewer: string;
  reviewComment: string;
  reviewedAt?: string;
}

export interface ApiConsumer {
  id: string;
  name: string;
  owner: string;
  environment: '生产' | '预发' | '灰度';
  clientVersion: string;
  requestsPerDay: number;
  contact: string;
}

export interface Exemption {
  id: string;
  changeId: string;
  scope: string;
  reason: string;
  approvedBy: string;
  expiresAt: string;
  /** 契约定义变化后豁免失效的时间，未设置表示仍然有效 */
  invalidatedAt?: string;
}

/** 一次完整差异计算的快照，导入失败时从这里恢复 */
export interface DiffSnapshot {
  id: string;
  /** 作为基线的最近冻结版本，null 表示尚无冻结基线 */
  baselineVersion: string | null;
  baselineChecksum: string | null;
  /** 产生这份差异的接口定义校验值 */
  sourceChecksum: string;
  computedAt: string;
  changeCount: number;
  changes: ContractChange[];
}

/** 引用展开快照：共享定义被哪些操作引用 */
export interface RefSnapshot {
  sourceChecksum: string;
  resolvedAt: string;
  /** backfilled 表示旧数据按当前定义回填，待人工核对 */
  status: 'ok' | 'backfilled';
  refs: Array<{ ref: string; usedBy: string[] }>;
}

export interface DefinitionError {
  message: string;
  occurredAt: string;
}

export interface ContractVersion {
  id: string;
  contractId: string;
  version: string;
  releasedAt: string;
  checksum: string;
  notes: string;
  changeIds: string[];
  openapi: string;
  /** 冻结时的完整差异快照，串起版本链 */
  diffSnapshot?: DiffSnapshot;
}

export interface ApiContract {
  id: string;
  name: string;
  version: string;
  domain: string;
  owner: string;
  protocol: 'REST' | 'GraphQL' | 'gRPC-Web';
  status: ContractStatus;
  updatedAt: string;
  openapi: string;
  changes: ContractChange[];
  consumers: ApiConsumer[];
  exemptions: Exemption[];
  versions: ContractVersion[];
  /** 最近一份有效差异快照，定义损坏或引用成环时据此恢复 */
  diffSnapshot?: DiffSnapshot;
  /** 引用展开快照，旧数据回填时标记为待核 */
  refSnapshot?: RefSnapshot;
  /** 当前定义无法解析或引用成环时记录错误，差异保留上一份有效结果 */
  definitionError?: DefinitionError | null;
}

export interface ReleaseIssue {
  id: string;
  severity: 'blocker' | 'warning';
  title: string;
  detail: string;
  changeId?: string;
}

export const CHANGE_KIND_LABELS: Record<ChangeKind, string> = {
  field_added: '新增字段',
  field_removed: '删除字段',
  field_moved: '字段移动',
  type_narrowed: '类型收紧',
  optionality_changed: '必填变化',
  enum_expanded: '枚举扩展',
  enum_shrunk: '枚举收缩',
  error_code_added: '新增错误码',
  error_code_removed: '错误码下线',
};

export const COMPATIBILITY_LABELS: Record<Compatibility, string> = {
  compatible: '兼容',
  warning: '警告',
  breaking: '不兼容',
};

export const REVIEW_STATE_LABELS: Record<ReviewState, string> = {
  pending: '待评审',
  accepted: '已接受',
  returned: '已退回',
  exemption: '兼容层豁免',
};

export const CONTRACT_STATUS_LABELS: Record<ContractStatus, string> = {
  draft: '草稿',
  review: '评审中',
  ready: '待发布',
  released: '已发布',
  frozen: '已冻结',
};

export function classifyChange(input: {
  kind: ChangeKind;
  before: string;
  after: string;
}): { compatibility: Compatibility; rationale: string } {
  switch (input.kind) {
    case 'field_removed':
      return {
        compatibility: 'breaking',
        rationale: '删除字段会使仍读取该字段的客户端解析失败或业务判断缺失。',
      };
    case 'field_moved':
      return {
        compatibility: 'breaking',
        rationale: '字段位置调整后，仍读取旧位置的调用方会丢失数据。',
      };
    case 'type_narrowed':
      return {
        compatibility: 'breaking',
        rationale: '类型或约束收紧后，原本合法的取值可能被拒绝。',
      };
    case 'enum_shrunk':
      return {
        compatibility: 'breaking',
        rationale: '移除枚举值会使仍使用该值的调用方解析或校验失败。',
      };
    case 'error_code_removed':
      return {
        compatibility: 'breaking',
        rationale: '删除错误码会破坏调用方基于错误码建立的分支与重试策略。',
      };
    case 'field_added':
      if (/required/i.test(input.after) || /必填/.test(input.after)) {
        return {
          compatibility: 'breaking',
          rationale: '新增必填字段要求现有调用方立即修改请求。',
        };
      }
      return {
        compatibility: 'compatible',
        rationale: '新增可选字段不会改变现有请求和响应结构。',
      };
    case 'optionality_changed':
      if (/可选.*必填|optional.*required/i.test(`${input.before} ${input.after}`)) {
        return {
          compatibility: 'breaking',
          rationale: '字段从可选变为必填，现有调用方可能不再满足请求约束。',
        };
      }
      return {
        compatibility: 'warning',
        rationale: '字段从必填变为可选会改变调用方对响应完整性的假设。',
      };
    case 'enum_expanded':
      return {
        compatibility: 'warning',
        rationale: '新增枚举值可能使未实现默认分支的客户端出现解析或展示异常。',
      };
    case 'error_code_added':
      return {
        compatibility: 'warning',
        rationale: '调用方应明确新错误码的展示和重试策略。',
      };
  }
}

export function validateForRelease(contract: ApiContract): ReleaseIssue[] {
  const issues: ReleaseIssue[] = [];

  if (contract.definitionError) {
    issues.push({
      id: 'definition-error',
      severity: 'blocker',
      title: '接口定义解析失败',
      detail: `${contract.definitionError.message}。当前差异保留自上一份有效快照，修复定义后才能发布。`,
    });
  }

  if (contract.refSnapshot?.status === 'backfilled') {
    issues.push({
      id: 'ref-backfilled',
      severity: 'warning',
      title: '引用快照待核对',
      detail: '旧数据缺少引用快照，已按当前定义回填。请核对引用展开结果后重新保存定义确认。',
    });
  }

  const invalidatedExemptions = contract.exemptions.filter((item) => item.invalidatedAt);
  if (invalidatedExemptions.length) {
    issues.push({
      id: 'exemptions-invalidated',
      severity: 'warning',
      title: '兼容层豁免已失效',
      detail: `${invalidatedExemptions.length} 条豁免因契约定义变化失效，需按新差异重新登记。`,
    });
  }

  const pending = contract.changes.filter((change) => change.reviewState === 'pending');
  pending.forEach((change) => {
    issues.push({
      id: `pending-${change.id}`,
      severity: 'blocker',
      title: '存在未处理变更',
      detail: `${change.method} ${change.path} 仍处于待评审状态。`,
      changeId: change.id,
    });
  });

  contract.changes
    .filter((change) => change.reviewState !== 'exemption')
    .forEach((change) => {
      if (change.compatibility === 'compatible') {
        return;
      }
      if (!change.impactStatement.trim()) {
        issues.push({
          id: `impact-${change.id}`,
          severity: 'blocker',
          title: '缺少调用方影响说明',
          detail: `${change.path} 需要说明受影响调用方、流量和业务影响。`,
          changeId: change.id,
        });
      } else if (change.impactStale) {
        issues.push({
          id: `impact-stale-${change.id}`,
          severity: 'blocker',
          title: '调用方说明待按新差异确认',
          detail: `${change.path} 的影响说明写于旧差异，契约定义变化后需重新确认并保存。`,
          changeId: change.id,
        });
      }
      if (!change.migrationPlan.trim()) {
        issues.push({
          id: `migration-${change.id}`,
          severity: 'blocker',
          title: '缺少迁移方案',
          detail: `${change.path} 需要给出客户端升级、兼容层或回滚路径。`,
          changeId: change.id,
        });
      }
    });

  contract.changes
    .filter(
      (change) =>
        change.compatibility === 'breaking' &&
        change.reviewState === 'accepted' &&
        !contract.exemptions.some((item) => item.changeId === change.id && !item.invalidatedAt),
    )
    .forEach((change) => {
      issues.push({
        id: `breaking-${change.id}`,
        severity: 'warning',
        title: '不兼容变更已接受但未登记豁免',
        detail: `${change.path} 需要记录兼容层的范围、原因和到期时间。`,
        changeId: change.id,
      });
    });

  return issues;
}
