# API 契约兼容性审查与版本发布平台

用于后端维护者、接口评审人和调用方负责人协作处理 API 契约变化的独立前端工程。工程没有真实后端，首次运行加载本地模拟契约，后续状态写入浏览器 `localStorage`。

## 技术栈

- React 19 + TypeScript + Vite 8
- shadcn/ui 风格本地组件 + Radix UI primitives
- Zustand + persist
- TanStack Router
- TanStack Query
- Monaco Editor / Diff Editor
- Tailwind CSS 4

## 功能

- OpenAPI JSON 导入、契约列表搜索和领域/状态筛选
- 接口定义解析成引用快照：`$ref` 就地展开，共享 components 的改法传播到每个引用它的操作
- 以最近冻结版本为基线的版本链：解析 → 契约差异 → 调用方影响 → 发布门禁
- 自动识别字段新增/删除/移动、类型收紧、枚举扩展/收缩、必填变化和错误码上下线
- 引用成环、悬空引用或文档损坏时拒绝导入并保留上一份有效差异，失败后可从完整差异快照恢复
- 重复导入同值定义不产生第二份差异；契约定义变化后旧评审结论和豁免失效重算
- 旧数据缺少引用快照时按当前定义回填并标成待核对，确认前阻断发布
- 自动判定兼容、警告或不兼容，并要求调用方影响说明与迁移方案
- Monaco Editor 编辑契约定义，Monaco Diff Editor 比较正式版本快照
- 调用方列表、示例请求生成、逐条接受、退回和兼容层豁免
- 跨契约批量评审、发布门禁、正式版本冻结与版本历史
- Markdown 变更报告与 JSON 导出

## 验证

```bash
node_modules/.bin/jiti scripts/verify-engine.ts   # 差异引擎行为
node_modules/.bin/jiti scripts/verify-service.ts  # 版本链与导入管线
```

## 运行

```bash
npm install
npm run dev
```

默认开发地址为 `http://localhost:18470`。

生产构建：

```bash
npm run build
```

构建输出位于 `dist`。

## 目录

```text
src/
  components/             shadcn/Radix 基础组件、业务组件、应用外壳
  data/                   本地模拟契约（真实 OpenAPI 文档，差异由引擎计算）
  lib/                    通用工具
  models/                 契约模型、OpenAPI 解析与引用展开、差异引擎、发布门禁
  pages/                  工作台、详情、批量评审、发布、报告
  services/               本地持久化、导入管线、数据迁移和 TanStack Query hooks
  store/                  Zustand 评审工作区状态
scripts/                差异引擎与版本链行为的验证脚本
```
