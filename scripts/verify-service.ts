/**
 * 临时验证脚本：服务层版本链行为。
 * 运行：node_modules/.bin/jiti scripts/verify-service.ts
 */

// 浏览器环境垫片（contract-service 依赖 localStorage 与 window.setTimeout）
const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
};
(globalThis as Record<string, unknown>).window = {
  setTimeout: (fn: () => void) => setTimeout(fn, 0),
};

const {
  listContracts,
  applyContractDefinition,
  importContractDocument,
  confirmDiffSnapshot,
  freezeVersion,
  reviewChange,
} = await import('../src/services/contract-service');
const { seedContracts } = await import('../src/data/seed');
const { validateForRelease } = await import('../src/models/contract');

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

console.log('== 旧数据迁移：缺少引用快照按当前定义回填并标成待核 ==');
const legacyContract = {
  id: 'contract-legacy',
  name: '遗留契约 API',
  version: '1.0.0',
  domain: '遗留',
  owner: '旧组',
  protocol: 'REST',
  status: 'review',
  updatedAt: '2026-09-01T00:00:00.000Z',
  openapi: JSON.stringify({
    openapi: '3.1.0',
    info: { title: '遗留契约 API', version: '1.0.0' },
    paths: {
      '/legacy': {
        get: {
          responses: {
            '200': {
              description: 'ok',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { id: { type: 'string' } } },
                },
              },
            },
          },
        },
      },
    },
  }),
  changes: [
    {
      id: 'chg-legacy-1',
      path: '/legacy',
      method: 'GET',
      kind: 'field_added',
      before: '无',
      after: '新增 id',
      compatibility: 'compatible',
      rationale: '旧登记',
      impactStatement: '',
      migrationPlan: '',
      reviewState: 'accepted',
      reviewer: '旧评审',
      reviewComment: '旧结论',
    },
  ],
  consumers: [],
  exemptions: [{ id: 'ex-1', changeId: 'chg-legacy-1', scope: 's', reason: 'r', approvedBy: 'a', expiresAt: '2026-01-01' }],
  versions: [],
};
store.set('pair-wise-gsb-70-contracts', JSON.stringify([legacyContract]));

const migrated = await listContracts();
const legacy = migrated.find((c) => c.id === 'contract-legacy')!;
check('回填差异快照存在', Boolean(legacy.diff), true);
check('回填快照标成待核', legacy.diff!.status, 'stale');
check('回填标记', legacy.diff!.backfilled, true);
check('旧变更保留', legacy.diff!.changes.length, 1);
check('旧变更评审结论保留', legacy.diff!.changes[0]!.reviewState, 'accepted');
check('引用快照已按当前定义回填', legacy.currentSnapshot!.operations.length, 1);
check('旧豁免补充生效状态', legacy.exemptions[0]!.status, 'active');
check('待核快照阻断发布', validateForRelease(legacy).some((i) => i.id === 'diff-stale' && i.severity === 'blocker'), true);

const confirmed = await confirmDiffSnapshot('contract-legacy');
check('核对后快照有效', confirmed.diff!.status, 'ok');
check('核对后阻断解除', validateForRelease(confirmed).some((i) => i.id === 'diff-stale'), false);

console.log('\n== 种子数据加载 ==');
store.delete('pair-wise-gsb-70-contracts');
const contracts = await listContracts();
check('种子契约数量', contracts.length, seedContracts.length);
check('种子差异非待核', contracts.every((c) => c.diff!.status === 'ok'), true);

console.log('\n== 重复导入不增加第二份差异 ==');
const order = contracts.find((c) => c.id === 'contract-order')!;
const diffIdBefore = order.diff!.id;
const dupResult = await applyContractDefinition('contract-order', order.openapi);
check('重复导入判定', dupResult.outcome.type, 'duplicate');
check('重复导入差异快照不变', dupResult.contract.diff!.id, diffIdBefore);
check('重复导入差异条数不变', dupResult.contract.diff!.changes.length, order.diff!.changes.length);

console.log('\n== 导入失败从完整差异快照恢复 ==');
const brokenResult = await applyContractDefinition('contract-order', '{ broken json');
check('坏文档保留有效差异', brokenResult.outcome.type, 'kept-last-valid');
check('坏文档后差异快照不变', brokenResult.contract.diff!.id, diffIdBefore);
check('坏文档后工作副本未被覆盖', brokenResult.contract.openapi, order.openapi);
check('坏文档后引用快照不变', brokenResult.contract.currentSnapshot!.checksum, order.currentSnapshot!.checksum);

const cyclicDoc = JSON.stringify({
  openapi: '3.1.0',
  info: { title: '订单履约 API', version: '2.8.0' },
  paths: {
    '/orders/{orderId}': {
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
    schemas: { Node: { type: 'object', properties: { child: { $ref: '#/components/schemas/Node' } } } },
  },
});
const cyclicResult = await applyContractDefinition('contract-order', cyclicDoc);
check('成环保留有效差异', cyclicResult.outcome.type, 'kept-last-valid');
check('成环后差异快照不变', cyclicResult.contract.diff!.id, diffIdBefore);
check('成环原因记录', cyclicResult.contract.lastImport!.outcome, 'kept-last-valid');

console.log('\n== 定义变化后旧评审结论和豁免失效重算 ==');
const changedDoc = JSON.parse(order.openapi) as {
  components: { schemas: { CancelRequest: { required: string[] } } };
};
changedDoc.components.schemas.CancelRequest.required = ['reason'];
const changedResult = await applyContractDefinition('contract-order', JSON.stringify(changedDoc, null, 2));
check('定义变化重算', changedResult.outcome.type, 'computed');
if (changedResult.outcome.type === 'computed') {
  check('requestId 变化消失（回到基线）', changedResult.outcome.removed >= 1, true);
}
const reqIdAfter = changedResult.contract.diff!.changes.find((c) => c.field === 'requestId');
check('requestId 差异已不存在', reqIdAfter === undefined, true);
check('豁免随旧差异失效', changedResult.contract.exemptions[0]!.status, 'invalidated');
check('失效原因', changedResult.contract.exemptions[0]!.invalidatedReason, '对应差异已不存在，豁免随旧差异失效');
const loyaltyAfter = changedResult.contract.diff!.changes.find((c) => c.field === 'loyaltyDiscount');
check('未变化差异结论沿用', loyaltyAfter!.reviewState, 'accepted');

console.log('\n== 评审后再次导入同值定义仍是重复 ==');
const reviewed = await reviewChange(
  'contract-order',
  changedResult.contract.diff!.changes[0]!.id,
  'accepted',
  '评审人甲',
  '确认',
);
check('评审写入差异快照', reviewed.diff!.changes[0]!.reviewState, 'accepted');
const dupAgain = await applyContractDefinition('contract-order', reviewed.openapi);
check('评审后重复导入判定', dupAgain.outcome.type, 'duplicate');
check('评审结论不被重复导入冲掉', dupAgain.contract.diff!.changes[0]!.reviewState, 'accepted');

console.log('\n== 冻结推进版本链 ==');
const all = await listContracts();
const user = all.find((c) => c.id === 'contract-user')!;
check('用户契约门禁通过', validateForRelease(user).filter((i) => i.severity === 'blocker').length, 0);
const frozen = await freezeVersion('contract-user', '1.14.0', '正式发布。');
check('冻结后状态', frozen.status, 'frozen');
check('冻结版本归档差异', frozen.versions[0]!.changes.length, 1);
check('冻结版本归档引用快照', Boolean(frozen.versions[0]!.snapshot), true);
check('差异基线推进到新版本', frozen.diff!.baselineVersion, '1.14.0');
check('冻结后差异清空', frozen.diff!.changes.length, 0);
const reimport = await applyContractDefinition('contract-user', frozen.openapi);
check('冻结后同值导入为重复', reimport.outcome.type, 'duplicate');

console.log('\n== 工作台导入：命中已有契约按新版本导入 ==');
const orderNow = (await listContracts()).find((c) => c.id === 'contract-order')!;
const importResult = await importContractDocument(orderNow.openapi);
check('同名导入判定重复', importResult.outcome.type, 'duplicate');
check('同名导入命中原契约', importResult.contract.id, 'contract-order');
const contractsAfterImport = await listContracts();
check('重复导入不新增契约', contractsAfterImport.filter((c) => c.name === '订单履约 API').length, 1);

const newDoc = JSON.stringify({
  openapi: '3.1.0',
  info: { title: '库存 API', version: '0.1.0' },
  paths: {
    '/stock': {
      get: {
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { sku: { type: 'string' } } },
              },
            },
          },
        },
      },
    },
  },
});
const created = await importContractDocument(newDoc);
check('新契约创建', created.outcome.type, 'created');
check('新契约无基线差异为空', created.contract.diff!.changes.length, 0);
const createdDup = await importContractDocument(newDoc);
check('新契约重复导入判定', createdDup.outcome.type, 'duplicate');
check('不新增第二份契约', (await listContracts()).filter((c) => c.name === '库存 API').length, 1);

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
