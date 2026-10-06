import { useNavigate } from '@tanstack/react-router';
import {
  ArrowRight,
  Boxes,
  FileJson,
  GitBranch,
  Plus,
  Search,
  ShieldAlert,
  Upload,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { Textarea } from '../components/ui/textarea';
import { formatDateTime } from '../lib/utils';
import {
  CONTRACT_STATUS_LABELS,
  type ApiContract,
  type ContractStatus,
} from '../models/contract';
import { useContracts, useSaveContract } from '../services/contract-queries';

type StatusFilter = ContractStatus | 'all';

export function DashboardPage() {
  const navigate = useNavigate();
  const contracts = useContracts();
  const saveContract = useSaveContract();
  const [query, setQuery] = useState('');
  const [domain, setDomain] = useState('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState('');

  const domains = useMemo(
    () => Array.from(new Set((contracts.data ?? []).map((contract) => contract.domain))),
    [contracts.data],
  );

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return (contracts.data ?? []).filter((contract) => {
      const matchesKeyword =
        !keyword ||
        `${contract.name} ${contract.owner} ${contract.version}`.toLowerCase().includes(keyword);
      return (
        matchesKeyword &&
        (domain === 'all' || contract.domain === domain) &&
        (status === 'all' || contract.status === status)
      );
    });
  }, [contracts.data, domain, query, status]);

  const metrics = useMemo(() => {
    const data = contracts.data ?? [];
    const pending = data.reduce(
      (sum, contract) =>
        sum + contract.changes.filter((change) => change.reviewState === 'pending').length,
      0,
    );
    const breaking = data.reduce(
      (sum, contract) =>
        sum + contract.changes.filter((change) => change.compatibility === 'breaking').length,
      0,
    );
    const consumers = data.reduce((sum, contract) => sum + contract.consumers.length, 0);
    return { pending, breaking, consumers, total: data.length };
  }, [contracts.data]);

  async function importContract() {
    setImportError('');
    try {
      const parsed = JSON.parse(importText) as {
        info?: { title?: string; version?: string };
        servers?: Array<{ url?: string }>;
      };
      if (!parsed.info?.title) {
        throw new Error('OpenAPI 文档缺少 info.title');
      }
      const now = new Date().toISOString();
      const contract: ApiContract = {
        id: `contract-${Date.now()}`,
        name: parsed.info.title,
        version: parsed.info.version ?? '0.1.0',
        domain: '待分类',
        owner: '当前用户',
        protocol: 'REST',
        status: 'draft',
        updatedAt: now,
        openapi: JSON.stringify(parsed, null, 2),
        changes: [],
        consumers: [],
        exemptions: [],
        versions: [],
      };
      await saveContract.mutateAsync(contract);
      setImportText('');
      setImportOpen(false);
      await navigate({ to: '/contracts/$contractId', params: { contractId: contract.id } });
    } catch (error) {
      setImportError(error instanceof Error ? error.message : '无法解析接口定义');
    }
  }

  return (
    <div>
      <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-sky-800">
            Contract Registry
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-normal text-slate-950 sm:text-3xl">
            API 契约兼容性工作台
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            识别字段、枚举和错误码变化对现有调用方的影响，在正式发布前完成逐条评审与迁移约束。
          </p>
        </div>
        <Dialog open={importOpen} onOpenChange={setImportOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4" />
              导入接口定义
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>导入 OpenAPI 文档</DialogTitle>
              <DialogDescription>
                粘贴 JSON 格式的 OpenAPI 定义。本地演示环境会创建契约草稿并写入 localStorage。
              </DialogDescription>
            </DialogHeader>
            <Textarea
              className="min-h-72 font-mono text-xs"
              value={importText}
              onChange={(event) => setImportText(event.target.value)}
              placeholder={'{\n  "openapi": "3.1.0",\n  "info": { "title": "示例 API", "version": "1.0.0" },\n  "paths": {}\n}'}
            />
            {importError && <p className="mt-2 text-sm text-red-700">{importError}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setImportOpen(false)}>
                取消
              </Button>
              <Button
                onClick={() => void importContract()}
                disabled={!importText.trim() || saveContract.isPending}
              >
                <Upload className="h-4 w-4" />
                {saveContract.isPending ? '导入中' : '创建契约'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <section className="mb-5 grid gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="管理契约" value={metrics.total} note="REST 接口定义" icon={Boxes} />
        <Metric label="待评审变化" value={metrics.pending} note="需要逐条结论" icon={GitBranch} />
        <Metric
          label="不兼容变化"
          value={metrics.breaking}
          note="需迁移或兼容层"
          icon={ShieldAlert}
          danger
        />
        <Metric label="依赖调用方" value={metrics.consumers} note="跨团队客户端" icon={FileJson} />
      </section>

      <Card>
        <CardHeader className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <CardTitle>契约清单</CardTitle>
            <p className="mt-1 text-xs text-slate-500">
              {filtered.length} / {contracts.data?.length ?? 0} 个契约
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative min-w-64">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input
                className="pl-9"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="名称、版本、负责人"
              />
            </div>
            <Select value={domain} onValueChange={setDomain}>
              <SelectTrigger>
                <SelectValue placeholder="全部领域" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部领域</SelectItem>
                {domains.map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={(value) => setStatus(value as StatusFilter)}>
              <SelectTrigger>
                <SelectValue placeholder="全部状态" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                {Object.entries(CONTRACT_STATUS_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {contracts.isLoading ? (
            <StateText>正在加载契约...</StateText>
          ) : contracts.isError ? (
            <StateText>契约加载失败，请刷新重试。</StateText>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[960px] border-collapse text-left text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500">
                  <tr>
                    <th className="px-4 py-3 font-medium">契约</th>
                    <th className="px-4 py-3 font-medium">状态</th>
                    <th className="px-4 py-3 font-medium">变更</th>
                    <th className="px-4 py-3 font-medium">调用方</th>
                    <th className="px-4 py-3 font-medium">负责人</th>
                    <th className="px-4 py-3 font-medium">更新</th>
                    <th className="px-4 py-3 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((contract) => {
                    const pending = contract.changes.filter(
                      (change) => change.reviewState === 'pending',
                    ).length;
                    const breaking = contract.changes.filter(
                      (change) => change.compatibility === 'breaking',
                    ).length;
                    return (
                      <tr
                        key={contract.id}
                        className="border-t border-slate-100 hover:bg-slate-50/80"
                      >
                        <td className="px-4 py-4">
                          <div className="font-medium text-slate-900">{contract.name}</div>
                          <div className="mt-1 text-xs text-slate-500">
                            {contract.domain} · {contract.protocol} · v{contract.version}
                          </div>
                        </td>
                        <td className="px-4 py-4">
                          <StatusBadge status={contract.status} />
                        </td>
                        <td className="px-4 py-4">
                          <div className="flex flex-wrap gap-1.5">
                            <Badge tone={pending ? 'amber' : 'green'}>
                              {pending ? `${pending} 待评审` : '评审完成'}
                            </Badge>
                            {breaking > 0 && <Badge tone="red">{breaking} 不兼容</Badge>}
                          </div>
                        </td>
                        <td className="px-4 py-4 text-slate-700">
                          {contract.consumers.length} 个
                        </td>
                        <td className="px-4 py-4 text-slate-700">{contract.owner}</td>
                        <td className="px-4 py-4 text-xs text-slate-500">
                          {formatDateTime(contract.updatedAt)}
                        </td>
                        <td className="px-4 py-4 text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              void navigate({
                                to: '/contracts/$contractId',
                                params: { contractId: contract.id },
                              })
                            }
                          >
                            打开
                            <ArrowRight className="h-3.5 w-3.5" />
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!filtered.length && <StateText>没有符合筛选条件的契约。</StateText>}
            </div>
          )}
        </CardContent>
      </Card>

      <section className="mt-5 grid gap-4 xl:grid-cols-[1.35fr_0.65fr]">
        <Card>
          <CardHeader>
            <CardTitle>最近正式版本</CardTitle>
            <p className="mt-1 text-xs text-slate-500">冻结版本保留校验值和变更摘要</p>
          </CardHeader>
          <CardContent className="space-y-3">
            {(contracts.data ?? [])
              .flatMap((contract) =>
                contract.versions.map((version) => ({ contract, version })),
              )
              .sort(
                (left, right) =>
                  new Date(right.version.releasedAt).getTime() -
                  new Date(left.version.releasedAt).getTime(),
              )
              .slice(0, 4)
              .map(({ contract, version }) => (
                <div
                  key={version.id}
                  className="flex flex-col justify-between gap-2 border-b border-slate-100 pb-3 last:border-0 last:pb-0 sm:flex-row sm:items-center"
                >
                  <div>
                    <div className="text-sm font-medium">{contract.name}</div>
                    <div className="mt-1 text-xs text-slate-500">
                      v{version.version} · {formatDateTime(version.releasedAt)} · {version.checksum}
                    </div>
                  </div>
                  <Badge tone="slate">已冻结</Badge>
                </div>
              ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>发布门禁</CardTitle>
            <p className="mt-1 text-xs text-slate-500">建议在发布前固定检查的顺序</p>
          </CardHeader>
          <CardContent>
            <ol className="space-y-4 text-sm text-slate-700">
              {[
                '逐条确认兼容、警告或不兼容结论',
                '为警告和不兼容变化补充调用方影响',
                '完成迁移方案或登记兼容层豁免',
                '冻结版本并生成变更报告',
              ].map((item, index) => (
                <li key={item} className="flex gap-3">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-sm bg-slate-100 text-xs font-semibold text-sky-900">
                    {index + 1}
                  </span>
                  <span className="pt-1">{item}</span>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function Metric({
  label,
  value,
  note,
  icon: Icon,
  danger = false,
}: {
  label: string;
  value: number;
  note: string;
  icon: typeof Boxes;
  danger?: boolean;
}) {
  return (
    <div className="bg-white p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-xs font-medium text-slate-500">{label}</div>
          <div className="mt-2 text-3xl font-semibold text-slate-950">{value}</div>
          <div className="mt-1 text-xs text-slate-500">{note}</div>
        </div>
        <div
          className={
            danger
              ? 'rounded-md bg-red-50 p-2 text-red-700'
              : 'rounded-md bg-sky-50 p-2 text-sky-800'
          }
        >
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: ContractStatus }) {
  const tone = {
    draft: 'neutral',
    review: 'amber',
    ready: 'blue',
    released: 'green',
    frozen: 'slate',
  }[status] as 'neutral' | 'amber' | 'blue' | 'green' | 'slate';
  return <Badge tone={tone}>{CONTRACT_STATUS_LABELS[status]}</Badge>;
}

function StateText({ children }: { children: string }) {
  return <div className="px-4 py-12 text-center text-sm text-slate-500">{children}</div>;
}
