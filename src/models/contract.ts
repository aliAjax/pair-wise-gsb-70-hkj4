import type { FieldDirection, ReferenceSnapshot, SnapshotWarning } from './openapi';

export type ContractStatus = 'draft' | 'review' | 'ready' | 'released' | 'frozen';
export type ChangeKind =
  | 'field_added'
  | 'field_removed'
  | 'field_moved'
  | 'type_narrowed'
  | 'type_changed'
  | 'optionality_changed'
  | 'enum_expanded'
  | 'enum_shrunk'
  | 'error_code_added'
  | 'error_code_removed';
export type Compatibility = 'compatible' | 'warning' | 'breaking';
export type ReviewState = 'pending' | 'accepted' | 'returned' | 'exemption';

export interface InvalidatedReview {
  reviewState: ReviewState;
  reviewer: string;
  reviewComment: string;
  reviewedAt?: string;
}

export interface ContractChange {
  /** 由差异内容决定的稳定 id，重复计算得到同一 id */
  id: string;
  /** 变化槽位标识（类别+操作+字段），与取值无关 */
  fingerprint: string;
  /** 变化内容标识（含变更前后取值），取值变化则签名变化 */
  signature: string;
  path: string;
  method: string;
  kind: ChangeKind;
  direction: FieldDirection;
  /** 字段路径（如 total.amount、query.currency）或错误码 */
  field: string;
  /** 该字段展开时经过的共享定义引用链 */
  refs: string[];
  before: string;
  after: string;
  compatibility: Compatibility;
  rationale: string;
  impactStatement: string;
  migrationPlan: string;
  reviewState: ReviewState;
  reviewer: string;
  reviewComment: string;
  reviewedAt?: string;
  /** 契约定义变化后失效的旧评审结论 */
  invalidatedFrom?: InvalidatedReview;
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
  /** 契约定义变化后旧豁免失效 */
  status: 'active' | 'invalidated';
  invalidatedReason?: string;
}

/**
 * 差异快照：工作副本相对最近冻结基线展开引用后算出的完整差异。
 * 导入失败时保留上一份有效差异，恢复以快照为准。
 */
export interface DiffSnapshot {
  id: string;
  baselineVersionId: string | null;
  baselineVersion: string;
  /** 生成本快照的源定义校验值，重复导入同值定义不产生第二份差异 */
  sourceChecksum: string;
  computedAt: string;
  /** stale = 旧数据缺少引用快照，按当前定义回填，待人工核对 */
  status: 'ok' | 'stale';
  backfilled: boolean;
  warnings: SnapshotWarning[];
  changes: ContractChange[];
  confirmedBy?: string;
  confirmedAt?: string;
}

export interface ImportRecord {
  at: string;
  outcome: 'computed' | 'duplicate' | 'kept-last-valid';
  detail: string;
  warnings: SnapshotWarning[];
}

export interface ContractVersion {
  id: string;
  contractId: string;
  version: string;
  releasedAt: string;
  checksum: string;
  notes: string;
  changeIds: string[];
  /** 冻结时归档的评审后差异 */
  changes: ContractChange[];
  diffId: string;
  openapi: string;
  /** 冻结时的引用快照，作为后续差异计算的基线 */
  snapshot: ReferenceSnapshot | null;
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
  currentSnapshot: ReferenceSnapshot | null;
  diff: DiffSnapshot | null;
  consumers: ApiConsumer[];
  exemptions: Exemption[];
  versions: ContractVersion[];
  lastImport?: ImportRecord;
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
  type_changed: '类型变化',
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

export const DIRECTION_LABELS: Record<FieldDirection, string> = {
  request: '请求',
  response: '响应',
};

export function contractChanges(contract: ApiContract): ContractChange[] {
  return contract.diff?.changes ?? [];
}

export interface ChangeFact {
  kind: ChangeKind;
  direction: FieldDirection;
  typeRelation?: 'narrowed' | 'widened' | 'incompatible';
  beforeRequired?: boolean;
  afterRequired?: boolean;
}

/** 按变化事实（方向、必填、类型关系）判定兼容性，不再依赖文本猜测 */
export function classifyChange(fact: ChangeFact): {
  compatibility: Compatibility;
  rationale: string;
} {
  const request = fact.direction === 'request';
  switch (fact.kind) {
    case 'field_added':
      if (request && fact.afterRequired) {
        return {
          compatibility: 'breaking',
          rationale: '新增必填请求字段，现有调用方必须立即补传，否则请求被拒绝。',
        };
      }
      return {
        compatibility: 'compatible',
        rationale: '新增可选字段不会改变现有请求和响应结构。',
      };
    case 'field_removed':
      return request
        ? {
            compatibility: 'warning',
            rationale: '服务端不再接受该请求字段，继续发送可能被拒绝或被静默忽略。',
          }
        : {
            compatibility: 'breaking',
            rationale: '删除响应字段会使仍读取该字段的客户端解析失败或业务判断缺失。',
          };
    case 'field_moved':
      return {
        compatibility: 'breaking',
        rationale: request
          ? '字段在请求体中的位置发生移动，未调整的调用方会把值发到失效路径。'
          : '字段在响应中的位置发生移动，仍按原路径读取的客户端将取不到值。',
      };
    case 'type_narrowed':
      return request
        ? {
            compatibility: 'breaking',
            rationale: '请求字段类型收紧，原本合法的取值可能被服务端拒绝。',
          }
        : {
            compatibility: 'warning',
            rationale: '响应字段类型收紧，客户端需确认解析逻辑兼容更窄的取值范围。',
          };
    case 'type_changed':
      if (fact.typeRelation === 'widened') {
        return request
          ? {
              compatibility: 'compatible',
              rationale: '请求字段类型放宽，服务端接受更宽的取值。',
            }
          : {
              compatibility: 'warning',
              rationale: '响应字段类型放宽，客户端需确认能解析更宽的取值。',
            };
      }
      return {
        compatibility: 'breaking',
        rationale: '字段类型发生不兼容变化，序列化与解析逻辑都需要调整。',
      };
    case 'optionality_changed':
      if (request) {
        return fact.afterRequired
          ? {
              compatibility: 'breaking',
              rationale: '请求字段从可选变为必填，现有调用方可能不再满足请求约束。',
            }
          : {
              compatibility: 'compatible',
              rationale: '请求字段从必填变为可选，现有调用不受影响。',
            };
      }
      return fact.afterRequired
        ? {
            compatibility: 'compatible',
            rationale: '响应字段变为必填，调用方获得更稳定的结构保证。',
          }
        : {
            compatibility: 'warning',
            rationale: '响应字段从必填变为可选，调用方对响应完整性的假设被打破。',
          };
    case 'enum_expanded':
      return request
        ? { compatibility: 'compatible', rationale: '请求枚举放开，服务端接受更多取值。' }
        : {
            compatibility: 'warning',
            rationale: '新增枚举值可能使未实现默认分支的客户端出现解析或展示异常。',
          };
    case 'enum_shrunk':
      return request
        ? {
            compatibility: 'breaking',
            rationale: '请求枚举收缩，仍在发送被移除取值的调用方会被拒绝。',
          }
        : {
            compatibility: 'warning',
            rationale: '响应枚举收缩，客户端应确认不依赖被移除的取值。',
          };
    case 'error_code_added':
      return {
        compatibility: 'warning',
        rationale: '调用方应明确新错误码的展示和重试策略。',
      };
    case 'error_code_removed':
      return {
        compatibility: 'breaking',
        rationale: '错误码下线会破坏调用方基于错误码建立的分支与重试策略。',
      };
  }
}

export function validateForRelease(contract: ApiContract): ReleaseIssue[] {
  const issues: ReleaseIssue[] = [];
  const diff = contract.diff;
  if (!diff) {
    issues.push({
      id: 'diff-missing',
      severity: 'blocker',
      title: '缺少差异快照',
      detail: '契约尚未建立引用快照，无法确认工作副本与冻结基线的差异。',
    });
    return issues;
  }
  const changes = diff.changes;

  if (diff.status === 'stale') {
    issues.push({
      id: 'diff-stale',
      severity: 'blocker',
      title: '差异快照待核对',
      detail:
        '该契约的差异由旧数据按当前定义回填，未经解析引擎核对。请核对后确认快照有效，或重新导入定义。',
    });
  }
  diff.warnings.forEach((warning, index) => {
    issues.push({
      id: `diff-warning-${index}`,
      severity: 'warning',
      title: '差异快照存在告警',
      detail: warning.detail,
    });
  });
  if (contract.lastImport?.outcome === 'kept-last-valid') {
    issues.push({
      id: 'import-kept-last-valid',
      severity: 'warning',
      title: '最近一次导入未生效',
      detail: `${contract.lastImport.detail}。当前差异仍是上一份有效快照。`,
    });
  }

  changes
    .filter((change) => change.reviewState === 'pending')
    .forEach((change) => {
      issues.push({
        id: `pending-${change.id}`,
        severity: 'blocker',
        title: '存在未处理变更',
        detail: `${change.method} ${change.path} 的 ${change.field} 仍处于待评审状态。`,
        changeId: change.id,
      });
    });

  changes
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
          detail: `${change.path} 的 ${change.field} 需要说明受影响调用方、流量和业务影响。`,
          changeId: change.id,
        });
      }
      if (!change.migrationPlan.trim()) {
        issues.push({
          id: `migration-${change.id}`,
          severity: 'blocker',
          title: '缺少迁移方案',
          detail: `${change.path} 的 ${change.field} 需要给出客户端升级、兼容层或回滚路径。`,
          changeId: change.id,
        });
      }
    });

  changes
    .filter(
      (change) =>
        change.compatibility === 'breaking' &&
        change.reviewState === 'accepted' &&
        !contract.exemptions.some(
          (item) => item.changeId === change.id && item.status !== 'invalidated',
        ),
    )
    .forEach((change) => {
      issues.push({
        id: `breaking-${change.id}`,
        severity: 'warning',
        title: '不兼容变更已接受但未登记豁免',
        detail: `${change.path} 的 ${change.field} 需要记录兼容层的范围、原因和到期时间。`,
        changeId: change.id,
      });
    });

  return issues;
}
