/**
 * 临时验证脚本：核对种子数据经差异引擎计算后的结果，
 * 以及重复导入 / 成环 / 坏文档 / 失效重算等版本链行为。
 * 运行：node_modules/.bin/jiti scripts/verify-engine.ts
 */
import { seedContracts } from '../src/data/seed';
import { diffSnapshots, mergeReviewState, refreshExemptions, relateTypes } from '../src/models/diff';
import { buildReferenceSnapshot } from '../src/models/openapi';
import { validateForRelease } from '../src/models/contract';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures += 1;
    console.error(`✗ ${label}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`);
  } else {
    console.log(`✓ ${label}`);
  }
}

const order = seedContracts.find((c) => c.id === 'contract-order')!;
const payment = seedContracts.find((c) => c.id === 'contract-payment')!;
const user = seedContracts.find((c) => c.id === 'contract-user')!;

console.log('== 订单履约 API 差异（共享定义传播） ==');
const orderKinds = order.diff!.changes.map((c) => `${c.kind}:${c.field}`).sort();
for (const k of orderKinds) console.log('  -', k);

// Money.amount number→integer 应传播到 GET 与 POST 两个操作的四处引用
const narrowed = order.diff!.changes.filter((c) => c.kind === 'type_narrowed');
check('类型收紧传播到 4 处引用', narrowed.length, 4);
check(
  '类型收紧字段路径',
  narrowed.map((c) => `${c.method} ${c.path} ${c.field}`).sort(),
  [
    'GET /orders/{orderId} items[].unitPrice.amount',
    'GET /orders/{orderId} total.amount',
    'POST /orders/{orderId}/cancel items[].unitPrice.amount',
    'POST /orders/{orderId}/cancel total.amount',
  ].sort(),
);
check('类型收紧经过共享定义引用链', narrowed[0]!.refs.length > 0, true);

// loyaltyDiscount 经共享 Order 传播到两个操作
const loyalty = order.diff!.changes.filter((c) => c.kind === 'field_added' && c.field === 'loyaltyDiscount');
check('共享 Order 的新字段传播到 2 个操作', loyalty.length, 2);
check('loyaltyDiscount 评审结论已沿用', loyalty.every((c) => c.reviewState === 'accepted'), true);

// requestId 必填变化
const reqId = order.diff!.changes.find((c) => c.kind === 'optionality_changed')!;
check('requestId 必填变化', [reqId.field, reqId.direction, reqId.compatibility], ['requestId', 'request', 'breaking']);
check('requestId 影响说明已填写', reqId.impactStatement.length > 0, true);

// currency 枚举收缩（请求参数）
const currency = order.diff!.changes.find((c) => c.kind === 'enum_shrunk')!;
check('currency 枚举收缩', [currency.field, currency.direction, currency.compatibility], ['query.currency', 'request', 'breaking']);

// status 枚举扩展
const statusExpanded = order.diff!.changes.filter((c) => c.kind === 'enum_expanded');
check('status 枚举扩展传播到 2 个操作', statusExpanded.length, 2);

// 错误码新增
const errAdded = order.diff!.changes.find((c) => c.kind === 'error_code_added')!;
check('ORDER_STATE_CONFLICT 新增错误码', errAdded.field, 'ORDER_STATE_CONFLICT');

// 豁免挂在 requestId 变化上且生效
const orderExemption = order.exemptions[0]!;
check('订单豁免挂到 requestId 变化', orderExemption.changeId, reqId.id);
check('订单豁免生效', orderExemption.status, 'active');

console.log('\n== 支付清算 API 差异（字段移动/枚举收缩/错误码下线） ==');
const paymentKinds = payment.diff!.changes.map((c) => `${c.kind}:${c.field}`).sort();
for (const k of paymentKinds) console.log('  -', k);

const moved = payment.diff!.changes.find((c) => c.kind === 'field_moved')!;
check('operator 字段移动', [moved.before, moved.after], ['位置 operator', '位置 audit.operator']);
check('字段移动判定不兼容', moved.compatibility, 'breaking');

const batchRemoved = payment.diff!.changes.find((c) => c.kind === 'field_removed')!;
check('settlementBatchId 删除字段', batchRemoved.field, 'settlementBatchId');
check('删除字段评审退回', batchRemoved.reviewState, 'returned');

const channel = payment.diff!.changes.find((c) => c.kind === 'enum_shrunk')!;
check('channel 枚举收缩', [channel.field, channel.compatibility], ['channel', 'breaking']);

const errRemoved = payment.diff!.changes.find((c) => c.kind === 'error_code_removed')!;
check('REFUND_DUPLICATE 错误码下线', [errRemoved.field, errRemoved.compatibility], ['REFUND_DUPLICATE', 'breaking']);

const legacyExemption = payment.exemptions.find((e) => e.id === 'ex-pay-legacy')!;
check('遗留豁免已失效', legacyExemption.status, 'invalidated');

console.log('\n== 用户权限 API ==');
check('effectiveRoles 新增', user.diff!.changes.length, 1);
check('effectiveRoles 类型', user.diff!.changes[0]!.after.includes('array<string>'), true);

console.log('\n== 发布门禁 ==');
const orderIssues = validateForRelease(order);
check('订单有待评审阻断', orderIssues.some((i) => i.id.startsWith('pending-')), true);
const userIssues = validateForRelease(user);
check('用户契约门禁通过', userIssues.filter((i) => i.severity === 'blocker').length, 0);

console.log('\n== 版本链行为 ==');
// 重复导入：同值定义 → 同一份差异（id 与签名完全一致）
const rebuilt = buildReferenceSnapshot(order.openapi);
check('当前定义可解析', rebuilt.ok, true);
if (rebuilt.ok) {
  check('重复计算校验值一致', rebuilt.snapshot.checksum, order.diff!.sourceChecksum);
  const recomputed = diffSnapshots(order.versions[0]!.snapshot, rebuilt.snapshot);
  const merged = mergeReviewState(order.diff!.changes, recomputed);
  check('重复导入新增 0 项', merged.added, 0);
  check('重复导入沿用全部', merged.carried, order.diff!.changes.length);
  check('重复导入失效 0 项', merged.invalidated, 0);
  check('重复导入差异 id 一致', recomputed.map((c) => c.id).sort(), order.diff!.changes.map((c) => c.id).sort());
}

// 定义变化：旧结论失效重算
const tamperedDoc = JSON.parse(order.openapi) as {
  components: { schemas: { Order: { properties: { loyaltyDiscount: { type: string } } } } };
};
tamperedDoc.components.schemas.Order.properties.loyaltyDiscount.type = 'integer';
const tampered = JSON.stringify(tamperedDoc, null, 2);
const tamperedBuilt = buildReferenceSnapshot(tampered);
check('篡改定义可解析', tamperedBuilt.ok, true);
if (tamperedBuilt.ok) {
  const recomputed = diffSnapshots(order.versions[0]!.snapshot, tamperedBuilt.snapshot);
  const merged = mergeReviewState(order.diff!.changes, recomputed);
  const loyaltyAfter = merged.changes.filter((c) => c.field === 'loyaltyDiscount');
  check('字段类型变化后旧结论失效', loyaltyAfter.every((c) => c.reviewState === 'pending'), true);
  check('失效记录保留旧结论', loyaltyAfter.every((c) => c.invalidatedFrom?.reviewState === 'accepted'), true);
  check('失效重算计数', merged.invalidated, 2);
  // 豁免失效：requestId 的豁免在 requestId 变化被篡改后应失效
  const tamperedDoc2 = JSON.parse(order.openapi) as {
    components: { schemas: { CancelRequest: { properties: Record<string, unknown> } } };
  };
  tamperedDoc2.components.schemas.CancelRequest.properties.requestIdX =
    tamperedDoc2.components.schemas.CancelRequest.properties.requestId;
  delete tamperedDoc2.components.schemas.CancelRequest.properties.requestId;
  const tampered2 = JSON.stringify(tamperedDoc2, null, 2);
  const built2 = buildReferenceSnapshot(tampered2);
  if (built2.ok) {
    const recomputed2 = diffSnapshots(order.versions[0]!.snapshot, built2.snapshot);
    const merged2 = mergeReviewState(order.diff!.changes, recomputed2);
    const exemptions = refreshExemptions(order.exemptions, order.diff!.changes, merged2.changes);
    check('定义变化后豁免失效', exemptions[0]!.status, 'invalidated');
  }
}

// 引用成环
const cyclic = JSON.stringify({
  openapi: '3.1.0',
  info: { title: '成环 API', version: '1.0.0' },
  paths: {
    '/nodes': {
      get: {
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Node: {
        type: 'object',
        properties: { child: { $ref: '#/components/schemas/Node' } },
      },
    },
  },
});
const cyclicResult = buildReferenceSnapshot(cyclic);
check('引用成环被拒绝', cyclicResult.ok, false);
if (!cyclicResult.ok) {
  check('成环告警类型', cyclicResult.warnings[0]!.kind, 'cycle');
}

// 悬空引用
const dangling = cyclic.replace('#/components/schemas/Node', '#/components/schemas/Missing');
const danglingResult = buildReferenceSnapshot(dangling);
check('悬空引用被拒绝', danglingResult.ok, false);
if (!danglingResult.ok) {
  check('悬空告警类型', danglingResult.warnings.some((w) => w.kind === 'broken_ref'), true);
}

// 坏文档
const brokenResult = buildReferenceSnapshot('{ not json');
check('坏文档被拒绝', brokenResult.ok, false);
if (!brokenResult.ok) {
  check('坏文档告警类型', brokenResult.warnings[0]!.kind, 'parse_error');
}

// 类型关系
check('number→integer 收紧', relateTypes('number', 'integer'), 'narrowed');
check('integer→number 放宽', relateTypes('integer', 'number'), 'widened');
check('string→string(date-time) 收紧', relateTypes('string', 'string(date-time)'), 'narrowed');
check('string→integer 不兼容', relateTypes('string', 'integer'), 'incompatible');

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
