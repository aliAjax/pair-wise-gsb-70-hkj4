import type { ApiContract, ChangeKind, ContractChange } from '../models/contract';
import { stableChecksum } from '../lib/utils';
import { computeDiffSnapshot } from '../services/diff-engine';

const orderOpenApiCurrent = `openapi: 3.1.0
info:
  title: 订单履约 API
  version: 2.8.0
servers:
  - url: https://api.example.com
paths:
  /orders/{orderId}:
    get:
      summary: 查询订单
      x-error-codes: [ORDER_NOT_FOUND, ORDER_LOCKED]
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Order'
  /orders/{orderId}/cancel:
    post:
      summary: 取消订单
      x-error-codes: [ORDER_NOT_FOUND, ORDER_NOT_CANCELLABLE]
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CancelOrderRequest'
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/CancelOrderResult'
components:
  schemas:
    Order:
      type: object
      required: [orderId, status]
      properties:
        orderId: { type: string }
        status: { type: string, enum: [CREATED, PAID, CANCELLED, PARTIAL_REFUND] }
        includeTimeline: { type: boolean }
        loyaltyDiscount: { type: number }
        totals: { $ref: '#/components/schemas/OrderTotals' }
    OrderTotals:
      type: object
      properties:
        currency: { type: string }
        amount: { type: number }
    CancelOrderRequest:
      type: object
      required: [orderId, requestId]
      properties:
        orderId: { type: string }
        reason: { type: string }
        requestId: { type: string }
    CancelOrderResult:
      type: object
      properties:
        cancelled: { type: boolean }
    Problem:
      type: object
      properties:
        code: { type: string }
        message: { type: string }
`;

const orderOpenApiBaseline = `openapi: 3.1.0
info:
  title: 订单履约 API
  version: 2.7.0
servers:
  - url: https://api.example.com
paths:
  /orders/{orderId}:
    get:
      summary: 查询订单
      x-error-codes: [ORDER_NOT_FOUND, ORDER_LOCKED, ORDER_ARCHIVED]
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Order'
  /orders/{orderId}/cancel:
    post:
      summary: 取消订单
      x-error-codes: [ORDER_NOT_FOUND, ORDER_NOT_CANCELLABLE]
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CancelOrderRequest'
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/CancelOrderResult'
components:
  schemas:
    Order:
      type: object
      required: [orderId, status]
      properties:
        orderId: { type: string }
        status: { type: string, enum: [CREATED, PAID, CANCELLED] }
        includeTimeline: { type: boolean }
        currency: { type: string }
    CancelOrderRequest:
      type: object
      required: [orderId]
      properties:
        orderId: { type: string }
        reason: { type: string }
        requestId: { type: string }
    CancelOrderResult:
      type: object
      properties:
        cancelled: { type: boolean }
    Problem:
      type: object
      properties:
        code: { type: string }
        message: { type: string }
`;

const paymentOpenApiCurrent = `openapi: 3.1.0
info:
  title: 支付清算 API
  version: 4.2.0
servers:
  - url: https://api.example.com
paths:
  /payments/{paymentId}:
    get:
      summary: 查询支付单
      x-error-codes: [PAYMENT_NOT_FOUND, RISK_HOLD]
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Payment'
  /refunds:
    post:
      summary: 创建退款
      x-error-codes: [REFUND_REJECTED, PAYMENT_NOT_FOUND]
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/RefundRequest'
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/RefundResult'
components:
  schemas:
    Payment:
      type: object
      properties:
        paymentId: { type: string }
        settlementCurrency: { type: string }
    RefundRequest:
      type: object
      required: [paymentId, amount]
      properties:
        paymentId: { type: string }
        amount: { type: integer, minimum: 1 }
        reason: { type: string }
    RefundResult:
      type: object
      properties:
        refundId: { type: string }
        status: { type: string, enum: [PENDING, DONE, FAILED] }
    Problem:
      type: object
      properties:
        code: { type: string }
        message: { type: string }
`;

const paymentOpenApiBaseline = `openapi: 3.1.0
info:
  title: 支付清算 API
  version: 4.1.0
servers:
  - url: https://api.example.com
paths:
  /payments/{paymentId}:
    get:
      summary: 查询支付单
      x-error-codes: [PAYMENT_NOT_FOUND]
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Payment'
  /refunds:
    post:
      summary: 创建退款
      x-error-codes: [REFUND_REJECTED, PAYMENT_NOT_FOUND]
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/RefundRequest'
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/RefundResult'
components:
  schemas:
    Payment:
      type: object
      properties:
        paymentId: { type: string }
        settlementCurrency: { type: string }
    RefundRequest:
      type: object
      required: [paymentId, amount]
      properties:
        paymentId: { type: string }
        amount: { type: number }
        reason: { type: string }
    RefundResult:
      type: object
      properties:
        refundId: { type: string }
        settlementBatchId: { type: string }
        status: { type: string, enum: [PENDING, DONE, FAILED] }
    Problem:
      type: object
      properties:
        code: { type: string }
        message: { type: string }
`;

const userOpenApiCurrent = `openapi: 3.1.0
info:
  title: 用户权限 API
  version: 1.14.0
servers:
  - url: https://api.example.com
paths:
  /users/{userId}:
    get:
      summary: 查询用户
      x-error-codes: [USER_NOT_FOUND]
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/UserProfile'
components:
  schemas:
    UserProfile:
      type: object
      required: [userId]
      properties:
        userId: { type: string }
        includeRoles: { type: boolean }
        effectiveRoles: { type: array, items: { type: string } }
        scope: { type: string, enum: [read, write] }
    Problem:
      type: object
      properties:
        code: { type: string }
        message: { type: string }
`;

const userOpenApiBaseline = `openapi: 3.1.0
info:
  title: 用户权限 API
  version: 1.13.0
servers:
  - url: https://api.example.com
paths:
  /users/{userId}:
    get:
      summary: 查询用户
      x-error-codes: [USER_NOT_FOUND]
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/UserProfile'
components:
  schemas:
    UserProfile:
      type: object
      required: [userId]
      properties:
        userId: { type: string }
        includeRoles: { type: boolean }
        scope: { type: string, enum: [read, write, admin] }
    Problem:
      type: object
      properties:
        code: { type: string }
        message: { type: string }
`;

interface ReviewOverlay {
  kind: ChangeKind;
  /** 指纹中包含的对象名，例如字段名或错误码 */
  subject: string;
  data: Partial<ContractChange>;
}

function applyOverlays(changes: ContractChange[], overlays: ReviewOverlay[]): ContractChange[] {
  return changes.map((change) => {
    const overlay = overlays.find(
      (item) => item.kind === change.kind && change.fingerprint.includes(item.subject),
    );
    return overlay ? { ...change, ...overlay.data } : change;
  });
}

function findChange(
  changes: ContractChange[],
  kind: ChangeKind,
  subject: string,
): ContractChange {
  const found = changes.find(
    (change) => change.kind === kind && change.fingerprint.includes(subject),
  );
  if (!found) {
    throw new Error(`种子数据缺少预期差异：${kind} ${subject}`);
  }
  return found;
}

/** 以最近冻结版本为基线计算差异，叠加评审结论后写入完整快照 */
function withComputedDiff(contract: ApiContract, overlays: ReviewOverlay[]): ApiContract {
  const computed = computeDiffSnapshot(contract, contract.openapi, contract.updatedAt);
  const changes = applyOverlays(computed.changes, overlays);
  return {
    ...contract,
    changes,
    diffSnapshot: { ...computed.snapshot, changes },
    refSnapshot: computed.refSnapshot,
    definitionError: null,
  };
}

const orderBase: ApiContract = {
  id: 'contract-order',
  name: '订单履约 API',
  version: '2.8.0',
  domain: '交易履约',
  owner: '订单平台组',
  protocol: 'REST',
  status: 'review',
  updatedAt: '2026-09-29T03:12:00.000Z',
  openapi: orderOpenApiCurrent,
  changes: [],
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
  versions: [
    {
      id: 'ver-order-270',
      contractId: 'contract-order',
      version: '2.7.0',
      releasedAt: '2026-08-18T09:30:00.000Z',
      checksum: stableChecksum(orderOpenApiBaseline),
      notes: '新增批量查询能力。',
      changeIds: [],
      openapi: orderOpenApiBaseline,
    },
  ],
};

const orderContract = withComputedDiff(orderBase, [
  {
    kind: 'field_added',
    subject: 'loyaltyDiscount',
    data: {
      reviewState: 'accepted',
      reviewer: '林墨',
      reviewComment: '可选响应字段，旧客户端忽略即可。',
      reviewedAt: '2026-09-29T02:10:00.000Z',
    },
  },
  {
    kind: 'optionality_changed',
    subject: 'requestId',
    data: {
      impactStatement: '取消订单客户端 12 个，其中 3 个生产调用方尚未升级。',
      migrationPlan: '发布前完成三个调用方灰度升级，兼容层保留 30 天。',
    },
  },
  {
    kind: 'enum_expanded',
    subject: 'status',
    data: {
      impactStatement: 'BI 报表和客服工作台会读取订单状态。',
      migrationPlan: '调用方增加未知状态兜底，项目组完成 SDK 4.7.0 升级。',
      reviewState: 'accepted',
      reviewer: '周言',
      reviewComment: '影响说明完整，允许进入兼容层观察。',
      reviewedAt: '2026-09-29T03:01:00.000Z',
    },
  },
]);

orderContract.exemptions = [
  {
    id: 'ex-order-1',
    changeId: findChange(orderContract.changes, 'optionality_changed', 'requestId').id,
    scope: '取消订单接口 requestId 校验',
    reason: '三个遗留调用方需要分阶段升级，兼容层临时允许缺失。',
    approvedBy: '付航',
    expiresAt: '2026-10-31',
  },
];

const paymentBase: ApiContract = {
  id: 'contract-payment',
  name: '支付清算 API',
  version: '4.2.0',
  domain: '支付结算',
  owner: '支付平台组',
  protocol: 'REST',
  status: 'review',
  updatedAt: '2026-09-28T10:40:00.000Z',
  openapi: paymentOpenApiCurrent,
  changes: [],
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
  exemptions: [],
  versions: [
    {
      id: 'ver-pay-410',
      contractId: 'contract-payment',
      version: '4.1.0',
      releasedAt: '2026-07-30T04:00:00.000Z',
      checksum: stableChecksum(paymentOpenApiBaseline),
      notes: '统一退款错误码。',
      changeIds: [],
      openapi: paymentOpenApiBaseline,
    },
  ],
};

const paymentContract = withComputedDiff(paymentBase, [
  {
    kind: 'field_removed',
    subject: 'settlementBatchId',
    data: {
      impactStatement: '财务对账服务仍使用该字段匹配批次。',
      migrationPlan: '先由对账服务切换 paymentId 匹配，稳定两周后删除字段。',
      reviewState: 'returned',
      reviewer: '韩度',
      reviewComment: '迁移方案未包含历史数据核对，退回补充。',
      reviewedAt: '2026-09-28T10:40:00.000Z',
    },
  },
  {
    kind: 'error_code_added',
    subject: 'RISK_HOLD',
    data: {
      impactStatement: '支付查询客户端会把未知错误码归类为系统异常。',
      migrationPlan: 'SDK 增加人工审核提示，旧客户端保持原错误兜底。',
      reviewState: 'accepted',
      reviewer: '韩度',
      reviewComment: '影响范围清晰。',
      reviewedAt: '2026-09-28T08:20:00.000Z',
    },
  },
  {
    kind: 'type_narrowed',
    subject: 'amount',
    data: {
      impactStatement: '退款金额从浮点元改为整数分，两个调用方仍按浮点提交。',
      migrationPlan: '网关兼容层完成单位换算后，再切换调用方 SDK。',
    },
  },
]);

const userBase: ApiContract = {
  id: 'contract-user',
  name: '用户权限 API',
  version: '1.14.0',
  domain: '身份权限',
  owner: '身份平台组',
  protocol: 'REST',
  status: 'review',
  updatedAt: '2026-09-27T06:15:00.000Z',
  openapi: userOpenApiCurrent,
  changes: [],
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
  versions: [
    {
      id: 'ver-user-1130',
      contractId: 'contract-user',
      version: '1.13.0',
      releasedAt: '2026-08-02T02:00:00.000Z',
      checksum: stableChecksum(userOpenApiBaseline),
      notes: '权限查询接口首次冻结。',
      changeIds: [],
      openapi: userOpenApiBaseline,
    },
  ],
};

const userContract = withComputedDiff(userBase, [
  {
    kind: 'field_added',
    subject: 'effectiveRoles',
    data: {
      reviewState: 'accepted',
      reviewer: '宋川',
      reviewComment: '可选字段，不影响旧客户端。',
      reviewedAt: '2026-09-27T06:15:00.000Z',
    },
  },
]);

export const seedContracts: ApiContract[] = [orderContract, paymentContract, userContract];
