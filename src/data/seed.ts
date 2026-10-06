import type { ApiContract, ChangeKind } from '../models/contract';
import { classifyChange } from '../models/contract';

function openApi(
  title: string,
  version: string,
  paths: Array<{ path: string; method: string; summary: string; fields: string[] }>,
): string {
  const pathEntries = paths
    .map((operation) => {
      const properties = operation.fields
        .map((field) => {
          const [name, type = 'string'] = field.split(':');
          return `              ${name}: { type: "${type}" }`;
        })
        .join(',\n');
      return `    ${operation.path}:
      ${operation.method}:
        summary: ${operation.summary}
        requestBody:
          content:
            application/json:
              schema:
                type: object
                properties:
${properties}`;
    })
    .join('\n');

  return `openapi: 3.1.0
info:
  title: ${title}
  version: ${version}
servers:
  - url: https://api.example.com
paths:
${pathEntries}
components:
  schemas:
    Problem:
      type: object
      properties:
        code: { type: string }
        message: { type: string }
`;
}

function change(
  id: string,
  path: string,
  method: string,
  kind: ChangeKind,
  before: string,
  after: string,
  overrides: Partial<Omit<ApiContract['changes'][number], 'id' | 'path' | 'method' | 'kind' | 'before' | 'after' | 'compatibility' | 'rationale'>> = {},
): ApiContract['changes'][number] {
  const classified = classifyChange({ kind, before, after });
  return {
    id,
    path,
    method,
    kind,
    before,
    after,
    compatibility: classified.compatibility,
    rationale: classified.rationale,
    impactStatement: '',
    migrationPlan: '',
    reviewState: 'pending',
    reviewer: '',
    reviewComment: '',
    ...overrides,
  };
}

const orderOpenApi = openApi('订单履约 API', '2.8.0', [
  {
    path: '/orders/{orderId}',
    method: 'get',
    summary: '查询订单',
    fields: ['orderId:string', 'includeTimeline:boolean', 'currency:string'],
  },
  {
    path: '/orders/{orderId}/cancel',
    method: 'post',
    summary: '取消订单',
    fields: ['orderId:string', 'reason:string', 'requestId:string'],
  },
]);

const paymentOpenApi = openApi('支付清算 API', '4.2.0', [
  {
    path: '/payments/{paymentId}',
    method: 'get',
    summary: '查询支付单',
    fields: ['paymentId:string', 'settlementCurrency:string'],
  },
  {
    path: '/refunds',
    method: 'post',
    summary: '创建退款',
    fields: ['paymentId:string', 'amount:number', 'reason:string'],
  },
]);

const userOpenApi = openApi('用户权限 API', '1.14.0', [
  {
    path: '/users/{userId}',
    method: 'get',
    summary: '查询用户',
    fields: ['userId:string', 'includeRoles:boolean'],
  },
]);

export const seedContracts: ApiContract[] = [
  {
    id: 'contract-order',
    name: '订单履约 API',
    version: '2.8.0',
    domain: '交易履约',
    owner: '订单平台组',
    protocol: 'REST',
    status: 'review',
    updatedAt: '2026-09-29T03:12:00.000Z',
    openapi: orderOpenApi,
    changes: [
      change(
        'chg-order-1',
        '/orders/{orderId}',
        'GET',
        'field_added',
        '响应字段集合不含 loyaltyDiscount',
        '新增可选响应字段 loyaltyDiscount: number',
        {
          reviewState: 'accepted',
          reviewer: '林墨',
          reviewComment: '可选响应字段，旧客户端忽略即可。',
          reviewedAt: '2026-09-29T02:10:00.000Z',
        },
      ),
      change(
        'chg-order-2',
        '/orders/{orderId}/cancel',
        'POST',
        'optionality_changed',
        'requestId 为可选字段',
        'requestId 变为必填字段',
        {
          impactStatement: '取消订单客户端 12 个，其中 3 个生产调用方尚未升级。',
          migrationPlan: '发布前完成三个调用方灰度升级，兼容层保留 30 天。',
          reviewState: 'pending',
        },
      ),
      change(
        'chg-order-3',
        '/orders/{orderId}',
        'GET',
        'enum_expanded',
        'status: CREATED | PAID | CANCELLED',
        'status: CREATED | PAID | CANCELLED | PARTIAL_REFUND',
        {
          impactStatement: 'BI 报表和客服工作台会读取订单状态。',
          migrationPlan: '调用方增加未知状态兜底，项目组完成 SDK 4.7.0 升级。',
          reviewState: 'accepted',
          reviewer: '周言',
          reviewComment: '影响说明完整，允许进入兼容层观察。',
          reviewedAt: '2026-09-29T03:01:00.000Z',
        },
      ),
    ],
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
    exemptions: [
      {
        id: 'ex-order-1',
        changeId: 'chg-order-2',
        scope: '取消订单接口 requestId 校验',
        reason: '三个遗留调用方需要分阶段升级，兼容层临时允许缺失。',
        approvedBy: '付航',
        expiresAt: '2026-10-31',
      },
    ],
    versions: [
      {
        id: 'ver-order-270',
        contractId: 'contract-order',
        version: '2.7.0',
        releasedAt: '2026-08-18T09:30:00.000Z',
        checksum: 'a18d73f2',
        notes: '新增批量查询能力。',
        changeIds: [],
        openapi: orderOpenApi.replaceAll('2.8.0', '2.7.0'),
      },
    ],
  },
  {
    id: 'contract-payment',
    name: '支付清算 API',
    version: '4.2.0',
    domain: '支付结算',
    owner: '支付平台组',
    protocol: 'REST',
    status: 'ready',
    updatedAt: '2026-09-28T10:40:00.000Z',
    openapi: paymentOpenApi,
    changes: [
      change(
        'chg-pay-1',
        '/refunds',
        'POST',
        'field_removed',
        '响应字段 settlementBatchId',
        '移除 settlementBatchId',
        {
          impactStatement: '财务对账服务仍使用该字段匹配批次。',
          migrationPlan: '先由对账服务切换 paymentId 匹配，稳定两周后删除字段。',
          reviewState: 'returned',
          reviewer: '韩度',
          reviewComment: '迁移方案未包含历史数据核对，退回补充。',
          reviewedAt: '2026-09-28T10:40:00.000Z',
        },
      ),
      change(
        'chg-pay-2',
        '/payments/{paymentId}',
        'GET',
        'error_code_added',
        '错误码集合不含 RISK_HOLD',
        '新增错误码 RISK_HOLD',
        {
          impactStatement: '支付查询客户端会把未知错误码归类为系统异常。',
          migrationPlan: 'SDK 增加人工审核提示，旧客户端保持原错误兜底。',
          reviewState: 'accepted',
          reviewer: '韩度',
          reviewComment: '影响范围清晰。',
          reviewedAt: '2026-09-28T08:20:00.000Z',
        },
      ),
    ],
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
        checksum: 'f9ac1220',
        notes: '统一退款错误码。',
        changeIds: [],
        openapi: paymentOpenApi.replaceAll('4.2.0', '4.1.0'),
      },
    ],
  },
  {
    id: 'contract-user',
    name: '用户权限 API',
    version: '1.14.0',
    domain: '身份权限',
    owner: '身份平台组',
    protocol: 'REST',
    status: 'review',
    updatedAt: '2026-09-27T06:15:00.000Z',
    openapi: userOpenApi,
    changes: [
      change(
        'chg-user-1',
        '/users/{userId}',
        'GET',
        'field_added',
        '响应不含 effectiveRoles',
        '新增可选响应字段 effectiveRoles: string[]',
        {
          reviewState: 'accepted',
          reviewer: '宋川',
          reviewComment: '可选字段，不影响旧客户端。',
          reviewedAt: '2026-09-27T06:15:00.000Z',
        },
      ),
    ],
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
    versions: [],
  },
];
