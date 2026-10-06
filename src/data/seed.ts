import type {
  ApiConsumer,
  ApiContract,
  ContractChange,
  ContractVersion,
  Exemption,
} from '../models/contract';
import { diffSnapshots } from '../models/diff';
import { buildReferenceSnapshot } from '../models/openapi';

/**
 * 本地模拟契约。每个契约携带基线版本与当前工作副本两份 OpenAPI JSON，
 * 差异由解析引擎真实计算：共享 components 的改法会传播到每个引用它的操作。
 */

type JsonDoc = Record<string, unknown>;

function doc(title: string, version: string, paths: JsonDoc, schemas: JsonDoc): string {
  return JSON.stringify(
    {
      openapi: '3.1.0',
      info: { title, version },
      servers: [{ url: 'https://api.example.com' }],
      paths,
      components: { schemas },
    },
    null,
    2,
  );
}

/* ---------------- 订单履约 API：共享 Order / Money 定义 ---------------- */

function orderSchemas(amountType: string, withLoyalty: boolean, withRefund: boolean): JsonDoc {
  return {
    Order: {
      type: 'object',
      required: ['orderId', 'status', 'total'],
      properties: {
        orderId: { type: 'string' },
        status: {
          type: 'string',
          enum: withRefund
            ? ['CREATED', 'PAID', 'CANCELLED', 'PARTIAL_REFUND']
            : ['CREATED', 'PAID', 'CANCELLED'],
        },
        total: { $ref: '#/components/schemas/Money' },
        items: { type: 'array', items: { $ref: '#/components/schemas/OrderItem' } },
        ...(withLoyalty ? { loyaltyDiscount: { type: 'number' } } : {}),
      },
    },
    OrderItem: {
      type: 'object',
      required: ['sku', 'quantity'],
      properties: {
        sku: { type: 'string' },
        quantity: { type: 'integer' },
        unitPrice: { $ref: '#/components/schemas/Money' },
      },
    },
    Money: {
      type: 'object',
      required: ['amount', 'currency'],
      properties: {
        amount: { type: amountType },
        currency: { type: 'string' },
      },
    },
    CancelRequest: {
      type: 'object',
      required: ['reason', 'requestId'],
      properties: {
        reason: { type: 'string' },
        requestId: { type: 'string' },
      },
    },
    Problem: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
      },
    },
  };
}

function orderPaths(currencyEnum: string[], cancelErrorCodes: string[]): JsonDoc {
  return {
    '/orders/{orderId}': {
      get: {
        summary: '查询订单',
        parameters: [
          { name: 'orderId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'includeTimeline', in: 'query', required: false, schema: { type: 'boolean' } },
          {
            name: 'currency',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: currencyEnum },
          },
        ],
        responses: {
          '200': {
            description: '订单详情',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Order' } },
            },
          },
          '404': {
            description: '订单不存在',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Problem' } },
            },
          },
        },
        'x-error-codes': ['ORDER_NOT_FOUND'],
      },
    },
    '/orders/{orderId}/cancel': {
      post: {
        summary: '取消订单',
        parameters: [{ name: 'orderId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/CancelRequest' } },
          },
        },
        responses: {
          '200': {
            description: '取消后的订单',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Order' } },
            },
          },
          '409': {
            description: '订单状态冲突',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Problem' } },
            },
          },
        },
        'x-error-codes': cancelErrorCodes,
      },
    },
  };
}

const orderBaselineDoc = doc(
  '订单履约 API',
  '2.7.0',
  orderPaths(['CNY', 'USD', 'EUR', 'JPY'], ['ORDER_NOT_CANCELLABLE', 'ORDER_LOCKED']),
  (() => {
    const schemas = orderSchemas('number', false, false) as {
      CancelRequest: { required: string[] };
    };
    schemas.CancelRequest.required = ['reason'];
    return schemas;
  })(),
);

const orderCurrentDoc = doc(
  '订单履约 API',
  '2.8.0',
  orderPaths(
    ['CNY', 'USD', 'EUR'],
    ['ORDER_NOT_CANCELLABLE', 'ORDER_LOCKED', 'ORDER_STATE_CONFLICT'],
  ),
  orderSchemas('integer', true, true),
);

/* ---------------- 支付清算 API：字段移动 / 枚举收缩 / 错误码下线 ---------------- */

function paymentSchemas(options: {
  channels: string[];
  refundErrorCodes: string[];
  withSettlementBatch: boolean;
  flatOperator: boolean;
}): JsonDoc {
  return {
    Payment: {
      type: 'object',
      required: ['paymentId', 'status', 'amount'],
      properties: {
        paymentId: { type: 'string' },
        status: { type: 'string', enum: ['PENDING', 'SUCCEEDED', 'FAILED'] },
        amount: { type: 'integer' },
      },
    },
    RefundRequest: {
      type: 'object',
      required: ['paymentId', 'amount', 'channel'],
      properties: {
        paymentId: { type: 'string' },
        amount: { type: 'number' },
        reason: { type: 'string' },
        channel: { type: 'string', enum: options.channels },
      },
    },
    RefundResponse: {
      type: 'object',
      required: ['refundId', 'status'],
      properties: {
        refundId: { type: 'string' },
        status: { type: 'string' },
        ...(options.withSettlementBatch ? { settlementBatchId: { type: 'string' } } : {}),
        ...(options.flatOperator
          ? { operator: { type: 'string' } }
          : {
              audit: {
                type: 'object',
                required: ['operator'],
                properties: {
                  operator: { type: 'string' },
                  channel: { type: 'string' },
                },
              },
            }),
      },
    },
    PaymentError: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
      },
    },
    RefundError: {
      type: 'object',
      properties: {
        code: { type: 'string', enum: options.refundErrorCodes },
        message: { type: 'string' },
      },
    },
  };
}

function paymentPaths(queryErrorCodes: string[]): JsonDoc {
  return {
    '/payments/{paymentId}': {
      get: {
        summary: '查询支付单',
        parameters: [
          { name: 'paymentId', in: 'path', required: true, schema: { type: 'string' } },
          {
            name: 'settlementCurrency',
            in: 'query',
            required: false,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: '支付单详情',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Payment' } },
            },
          },
          '404': {
            description: '支付单不存在',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/PaymentError' } },
            },
          },
        },
        'x-error-codes': queryErrorCodes,
      },
    },
    '/refunds': {
      post: {
        summary: '创建退款',
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/RefundRequest' } },
          },
        },
        responses: {
          '200': {
            description: '退款受理结果',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/RefundResponse' } },
            },
          },
          '409': {
            description: '退款冲突',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/RefundError' } },
            },
          },
        },
      },
    },
  };
}

const paymentBaselineDoc = doc(
  '支付清算 API',
  '4.1.0',
  paymentPaths(['PAYMENT_NOT_FOUND']),
  paymentSchemas({
    channels: ['BANK', 'WALLET', 'CASH'],
    refundErrorCodes: ['REFUND_DUPLICATE', 'REFUND_LIMIT_EXCEEDED'],
    withSettlementBatch: true,
    flatOperator: true,
  }),
);

const paymentCurrentDoc = doc(
  '支付清算 API',
  '4.2.0',
  paymentPaths(['PAYMENT_NOT_FOUND', 'RISK_HOLD']),
  paymentSchemas({
    channels: ['BANK', 'WALLET'],
    refundErrorCodes: ['REFUND_LIMIT_EXCEEDED'],
    withSettlementBatch: false,
    flatOperator: false,
  }),
);

/* ---------------- 用户权限 API ---------------- */

function userSchemas(withEffectiveRoles: boolean): JsonDoc {
  return {
    User: {
      type: 'object',
      required: ['userId', 'name'],
      properties: {
        userId: { type: 'string' },
        name: { type: 'string' },
        roles: { type: 'array', items: { type: 'string' } },
        ...(withEffectiveRoles
          ? { effectiveRoles: { type: 'array', items: { type: 'string' } } }
          : {}),
      },
    },
    AccessError: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
      },
    },
  };
}

const userPaths: JsonDoc = {
  '/users/{userId}': {
    get: {
      summary: '查询用户',
      parameters: [
        { name: 'userId', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'includeRoles', in: 'query', required: false, schema: { type: 'boolean' } },
      ],
      responses: {
        '200': {
          description: '用户详情',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } },
        },
        '403': {
          description: '无权访问',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/AccessError' } },
          },
        },
      },
      'x-error-codes': ['USER_FORBIDDEN'],
    },
  },
};

const userBaselineDoc = doc('用户权限 API', '1.13.0', userPaths, userSchemas(false));
const userCurrentDoc = doc('用户权限 API', '1.14.0', userPaths, userSchemas(true));

/* ---------------- 装配 ---------------- */

function patchChanges(
  changes: ContractChange[],
  field: string,
  kind: ContractChange['kind'],
  patch: Partial<ContractChange>,
): void {
  for (const change of changes) {
    if (change.field === field && change.kind === kind) {
      Object.assign(change, patch);
    }
  }
}

function findChangeId(changes: ContractChange[], field: string, kind: ContractChange['kind']): string {
  return changes.find((change) => change.field === field && change.kind === kind)?.id ?? '';
}

interface SeedInput {
  id: string;
  name: string;
  version: string;
  domain: string;
  owner: string;
  status: ApiContract['status'];
  updatedAt: string;
  currentDoc: string;
  baseline?: { version: string; releasedAt: string; notes: string; source: string };
  consumers: ApiConsumer[];
  exemptions: Exemption[];
  applyReview: (changes: ContractChange[]) => void;
}

function buildSeedContract(input: SeedInput): ApiContract {
  const current = buildReferenceSnapshot(input.currentDoc);
  if (!current.ok) {
    throw new Error(`种子契约 ${input.id} 的当前定义无效：${current.error}`);
  }
  const versions: ContractVersion[] = [];
  let baselineSnapshot = null;
  if (input.baseline) {
    const built = buildReferenceSnapshot(input.baseline.source);
    if (!built.ok) {
      throw new Error(`种子契约 ${input.id} 的基线定义无效：${built.error}`);
    }
    baselineSnapshot = built.snapshot;
    versions.push({
      id: `ver-${input.id}-baseline`,
      contractId: input.id,
      version: input.baseline.version,
      releasedAt: input.baseline.releasedAt,
      checksum: built.snapshot.checksum,
      notes: input.baseline.notes,
      changeIds: [],
      changes: [],
      diffId: '',
      openapi: input.baseline.source,
      snapshot: built.snapshot,
    });
  }
  const changes = diffSnapshots(baselineSnapshot, current.snapshot);
  input.applyReview(changes);
  return {
    id: input.id,
    name: input.name,
    version: input.version,
    domain: input.domain,
    owner: input.owner,
    protocol: 'REST',
    status: input.status,
    updatedAt: input.updatedAt,
    openapi: input.currentDoc,
    currentSnapshot: current.snapshot,
    diff: {
      id: `diff-${input.id}`,
      baselineVersionId: versions[0]?.id ?? null,
      baselineVersion: input.baseline?.version ?? '',
      sourceChecksum: current.snapshot.checksum,
      computedAt: input.updatedAt,
      status: 'ok',
      backfilled: false,
      warnings: [],
      changes,
    },
    consumers: input.consumers,
    exemptions: input.exemptions,
    versions,
  };
}

const orderContract = buildSeedContract({
  id: 'contract-order',
  name: '订单履约 API',
  version: '2.8.0',
  domain: '交易履约',
  owner: '订单平台组',
  status: 'review',
  updatedAt: '2026-09-29T03:12:00.000Z',
  currentDoc: orderCurrentDoc,
  baseline: {
    version: '2.7.0',
    releasedAt: '2026-08-18T09:30:00.000Z',
    notes: '新增批量查询能力。',
    source: orderBaselineDoc,
  },
  consumers: [
    {
      id: 'consumer-app',
      name: '订单中心',
      owner: '交易应用组',
      environment: '生产',
      clientVersion: '4.6.2',
      requestsPerDay: 4800000,
      contact: 'app-order@example.com',
    },
    {
      id: 'consumer-cs',
      name: '客服工作台',
      owner: '服务体验组',
      environment: '生产',
      clientVersion: '3.9.0',
      requestsPerDay: 680000,
      contact: 'cs-platform@example.com',
    },
    {
      id: 'consumer-bi',
      name: '经营分析',
      owner: '数据产品组',
      environment: '预发',
      clientVersion: '2.1.5',
      requestsPerDay: 220000,
      contact: 'bi-api@example.com',
    },
  ],
  exemptions: [],
  applyReview(changes) {
    patchChanges(changes, 'loyaltyDiscount', 'field_added', {
      reviewState: 'accepted',
      reviewer: '林墨',
      reviewComment: '可选响应字段，旧客户端忽略即可。',
      reviewedAt: '2026-09-29T02:10:00.000Z',
    });
    patchChanges(changes, 'status', 'enum_expanded', {
      impactStatement: 'BI 报表和客服工作台会读取订单状态。',
      migrationPlan: '调用方增加未知状态兜底，项目组完成 SDK 4.7.0 升级。',
      reviewState: 'accepted',
      reviewer: '周言',
      reviewComment: '影响说明完整，允许进入兼容层观察。',
      reviewedAt: '2026-09-29T03:01:00.000Z',
    });
    patchChanges(changes, 'requestId', 'optionality_changed', {
      impactStatement: '取消订单客户端 12 个，其中 3 个生产调用方尚未升级。',
      migrationPlan: '发布前完成三个调用方灰度升级，兼容层保留 30 天。',
    });
  },
});

orderContract.exemptions.push({
  id: 'ex-order-1',
  changeId: findChangeId(orderContract.diff?.changes ?? [], 'requestId', 'optionality_changed'),
  scope: '取消订单接口 requestId 校验',
  reason: '三个遗留调用方需要分阶段升级，兼容层临时允许缺失。',
  approvedBy: '付航',
  expiresAt: '2026-10-31',
  status: 'active',
});

const paymentContract = buildSeedContract({
  id: 'contract-payment',
  name: '支付清算 API',
  version: '4.2.0',
  domain: '支付结算',
  owner: '支付平台组',
  status: 'ready',
  updatedAt: '2026-09-28T10:40:00.000Z',
  currentDoc: paymentCurrentDoc,
  baseline: {
    version: '4.1.0',
    releasedAt: '2026-07-30T04:00:00.000Z',
    notes: '统一退款错误码。',
    source: paymentBaselineDoc,
  },
  consumers: [
    {
      id: 'consumer-finance',
      name: '财务对账',
      owner: '财务研发组',
      environment: '生产',
      clientVersion: '5.2.0',
      requestsPerDay: 1100000,
      contact: 'finance-api@example.com',
    },
    {
      id: 'consumer-pay-ops',
      name: '支付运营台',
      owner: '支付产品组',
      environment: '生产',
      clientVersion: '4.1.8',
      requestsPerDay: 320000,
      contact: 'pay-ops@example.com',
    },
  ],
  exemptions: [
    {
      id: 'ex-pay-legacy',
      changeId: 'chg-legacy-channel',
      scope: '退款 channel 旧枚举兼容',
      reason: '旧收银台仍发送 CASH，兼容层临时映射为 BANK。',
      approvedBy: '付航',
      expiresAt: '2026-08-31',
      status: 'invalidated',
      invalidatedReason: '契约定义变化，豁免随旧差异失效',
    },
  ],
  applyReview(changes) {
    patchChanges(changes, 'settlementBatchId', 'field_removed', {
      impactStatement: '财务对账服务仍使用该字段匹配批次。',
      migrationPlan: '先由对账服务切换 paymentId 匹配，稳定两周后删除字段。',
      reviewState: 'returned',
      reviewer: '韩度',
      reviewComment: '迁移方案未包含历史数据核对，退回补充。',
      reviewedAt: '2026-09-28T10:40:00.000Z',
    });
    patchChanges(changes, 'RISK_HOLD', 'error_code_added', {
      impactStatement: '支付查询客户端会把未知错误码归类为系统异常。',
      migrationPlan: 'SDK 增加人工审核提示，旧客户端保持原错误兜底。',
      reviewState: 'accepted',
      reviewer: '韩度',
      reviewComment: '影响范围清晰。',
      reviewedAt: '2026-09-28T08:20:00.000Z',
    });
    patchChanges(changes, 'audit.channel', 'field_added', {
      reviewState: 'accepted',
      reviewer: '韩度',
      reviewComment: '新增可选字段，不影响旧客户端。',
      reviewedAt: '2026-09-28T09:05:00.000Z',
    });
  },
});

const userContract = buildSeedContract({
  id: 'contract-user',
  name: '用户权限 API',
  version: '1.14.0',
  domain: '身份权限',
  owner: '身份平台组',
  status: 'review',
  updatedAt: '2026-09-27T06:15:00.000Z',
  currentDoc: userCurrentDoc,
  baseline: {
    version: '1.13.0',
    releasedAt: '2026-08-02T02:00:00.000Z',
    notes: '权限模型梳理。',
    source: userBaselineDoc,
  },
  consumers: [
    {
      id: 'consumer-admin',
      name: '权限管理台',
      owner: '安全产品组',
      environment: '生产',
      clientVersion: '1.12.3',
      requestsPerDay: 180000,
      contact: 'iam-console@example.com',
    },
  ],
  exemptions: [],
  applyReview(changes) {
    patchChanges(changes, 'effectiveRoles', 'field_added', {
      reviewState: 'accepted',
      reviewer: '宋川',
      reviewComment: '可选字段，不影响旧客户端。',
      reviewedAt: '2026-09-27T06:15:00.000Z',
    });
  },
});

export const seedContracts: ApiContract[] = [orderContract, paymentContract, userContract];
