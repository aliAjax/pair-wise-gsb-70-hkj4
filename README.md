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

- OpenAPI JSON/YAML 导入、契约列表搜索和领域/状态筛选
- 接口定义解析、引用展开、契约差异、调用方影响与发布门禁串成版本链
- 以最近冻结版本为基线展开 `$ref` 共享定义，识别字段移动、类型收紧、枚举收缩、必填变化和错误码下线
- 引用成环或文档损坏时保留上一份有效差异快照，修复后自动恢复；重复导入不产生第二份差异
- 契约定义变化后旧评审结论与兼容层豁免失效重算，调用方影响说明需按新差异重新确认
- 旧数据缺少引用快照时按当前定义回填并标记待核，重新保存定义后确认
- 自动判定兼容、警告或不兼容，并要求调用方影响说明与迁移方案
- Monaco Editor 编辑契约定义，Monaco Diff Editor 比较正式版本快照
- 调用方列表、示例请求生成、逐条接受、退回和兼容层豁免
- 跨契约批量评审、发布门禁、正式版本冻结与版本历史
- Markdown 变更报告与 JSON 导出

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
  data/                   本地模拟契约（差异由引擎按冻结基线真实计算）
  lib/                    通用工具、YAML 子集解析器
  models/                 契约模型、兼容性与发布门禁规则
  pages/                  工作台、详情、批量评审、发布、报告
  services/               OpenAPI 解析与引用展开、差异引擎、本地持久化和 TanStack Query hooks
  store/                  Zustand 评审工作区状态
```
