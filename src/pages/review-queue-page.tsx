import { Link } from '@tanstack/react-router';
import { Check, CornerUpLeft, Filter, ListChecks, RotateCcw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { CompatibilityBadge, ReviewStateBadge } from '../components/contract/compatibility-badge';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Checkbox } from '../components/ui/checkbox';
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
  CHANGE_KIND_LABELS,
  REVIEW_STATE_LABELS,
  type ContractChange,
  type ReviewState,
} from '../models/contract';
import { useBulkReview, useContracts } from '../services/contract-queries';
import { useReviewStore } from '../store/review-store';

interface QueueItem {
  contractId: string;
  contractName: string;
  version: string;
  updatedAt: string;
  change: ContractChange;
}

export function ReviewQueuePage() {
  const contracts = useContracts();
  const bulkReview = useBulkReview();
  const reviewStateFilter = useReviewStore((state) => state.reviewStateFilter);
  const setReviewStateFilter = useReviewStore((state) => state.setReviewStateFilter);
  const selection = useReviewStore((state) => state.selection);
  const toggleSelection = useReviewStore((state) => state.toggleSelection);
  const clearSelection = useReviewStore((state) => state.clearSelection);
  const selectMany = useReviewStore((state) => state.selectMany);
  const [query, setQuery] = useState('');
  const [reviewer, setReviewer] = useState('当前评审人');
  const [comment, setComment] = useState('');

  const queue = useMemo<QueueItem[]>(
    () =>
      (contracts.data ?? [])
        .flatMap((contract) =>
          contract.changes.map((change) => ({
            contractId: contract.id,
            contractName: contract.name,
            version: contract.version,
            updatedAt: contract.updatedAt,
            change,
          })),
        )
        .filter((item) => {
          const keyword = query.trim().toLowerCase();
          return (
            (reviewStateFilter === 'all' ||
              item.change.reviewState === reviewStateFilter) &&
            (!keyword ||
              `${item.contractName} ${item.change.path} ${item.change.method}`
                .toLowerCase()
                .includes(keyword))
          );
        })
        .sort((left, right) => {
          const rank = { breaking: 0, warning: 1, compatible: 2 };
          return rank[left.change.compatibility] - rank[right.change.compatibility];
        }),
    [contracts.data, query, reviewStateFilter],
  );

  const selectedKeys = new Set(
    selection.map((item) => `${item.contractId}:${item.changeId}`),
  );

  function selectAllVisible() {
    if (queue.every((item) => selectedKeys.has(`${item.contractId}:${item.change.id}`))) {
      selectMany([]);
      return;
    }
    selectMany(
      queue.map((item) => ({
        contractId: item.contractId,
        changeId: item.change.id,
      })),
    );
  }

  async function submitBulk(state: ReviewState) {
    if (!selection.length || !comment.trim()) return;
    await bulkReview.mutateAsync({
      selections: selection,
      state,
      reviewer: reviewer.trim() || '当前评审人',
      comment: comment.trim(),
    });
    clearSelection();
    setComment('');
  }

  return (
    <div>
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-sky-800">Review Queue</p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-950 sm:text-3xl">
          批量变更评审
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
          按兼容性风险排序处理跨契约变更。批量结论会写入每个变更项，并保留评审人与意见。
        </p>
      </div>

      <div className="mb-4 grid gap-4 lg:grid-cols-[1fr_340px]">
        <Card>
          <CardHeader className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div>
              <CardTitle>评审队列</CardTitle>
              <p className="mt-1 text-xs text-slate-500">{queue.length} 项待处理或历史结论</p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="契约、路径或方法"
              />
              <Select
                value={reviewStateFilter}
                onValueChange={(value) => setReviewStateFilter(value as ReviewState | 'all')}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部状态</SelectItem>
                  {Object.entries(REVIEW_STATE_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="flex items-center gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3">
              <Checkbox
                checked={!!queue.length && queue.every((item) => selectedKeys.has(`${item.contractId}:${item.change.id}`))}
                onCheckedChange={selectAllVisible}
                aria-label="选择当前全部"
              />
              <span className="text-xs font-medium text-slate-600">选择当前列表</span>
              <span className="ml-auto text-xs text-slate-500">已选 {selection.length} 项</span>
            </div>

            {contracts.isLoading ? (
              <QueueState text="正在加载评审队列..." />
            ) : (
              queue.map((item) => {
                const key = `${item.contractId}:${item.change.id}`;
                return (
                  <article
                    key={key}
                    className="grid gap-3 border-b border-slate-100 px-4 py-4 last:border-0 lg:grid-cols-[24px_1fr_auto]"
                  >
                    <Checkbox
                      className="mt-1"
                      checked={selectedKeys.has(key)}
                      onCheckedChange={() =>
                        toggleSelection({
                          contractId: item.contractId,
                          changeId: item.change.id,
                        })
                      }
                      aria-label={`选择 ${item.contractName} ${item.change.path}`}
                    />
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          to="/contracts/$contractId"
                          params={{ contractId: item.contractId }}
                          className="text-sm font-semibold text-sky-900 hover:underline"
                        >
                          {item.contractName}
                        </Link>
                        <Badge tone="neutral">v{item.version}</Badge>
                        <CompatibilityBadge value={item.change.compatibility} />
                        <ReviewStateBadge value={item.change.reviewState} />
                      </div>
                      <div className="mt-2 font-mono text-xs text-slate-600">
                        {item.change.method} {item.change.path}
                      </div>
                      <div className="mt-2 text-sm font-medium text-slate-900">
                        {CHANGE_KIND_LABELS[item.change.kind]}
                      </div>
                      <p className="mt-1 max-w-4xl text-xs leading-5 text-slate-500">
                        {item.change.rationale}
                      </p>
                    </div>
                    <div className="text-left text-[11px] text-slate-500 lg:text-right">
                      <div>{formatDateTime(item.updatedAt)}</div>
                      <div className="mt-1">{item.change.reviewer || '未评审'}</div>
                    </div>
                  </article>
                );
              })
            )}
            {!contracts.isLoading && !queue.length && <QueueState text="没有符合条件的变更项。" />}
          </CardContent>
        </Card>

        <Card className="h-fit lg:sticky lg:top-24">
          <CardHeader>
            <CardTitle>批量结论</CardTitle>
            <p className="mt-1 text-xs text-slate-500">
              批量操作只适用于影响和迁移说明已经完整的变更
            </p>
          </CardHeader>
          <CardContent>
            <label className="text-xs font-medium text-slate-700">评审人</label>
            <Input
              className="mt-1.5"
              value={reviewer}
              onChange={(event) => setReviewer(event.target.value)}
            />
            <label className="mt-4 block text-xs font-medium text-slate-700">统一意见</label>
            <Textarea
              className="mt-1.5"
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder="例如：影响说明与迁移窗口确认，接受本批兼容性警告。"
            />
            <div className="mt-4 space-y-2">
              <Button
                className="w-full"
                disabled={!selection.length || !comment.trim() || bulkReview.isPending}
                onClick={() => void submitBulk('accepted')}
              >
                <Check className="h-4 w-4" />
                批量接受
              </Button>
              <Button
                className="w-full"
                variant="secondary"
                disabled={!selection.length || !comment.trim() || bulkReview.isPending}
                onClick={() => void submitBulk('returned')}
              >
                <CornerUpLeft className="h-4 w-4" />
                批量退回
              </Button>
              <Button
                className="w-full"
                variant="ghost"
                disabled={!selection.length}
                onClick={clearSelection}
              >
                <RotateCcw className="h-4 w-4" />
                清空选择
              </Button>
            </div>
            <div className="mt-5 border-t border-slate-100 pt-4">
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <Filter className="h-3.5 w-3.5" />
                当前筛选对应 {queue.length} 项
              </div>
              <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
                <ListChecks className="h-3.5 w-3.5" />
                已选择 {selection.length} 项
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function QueueState({ text }: { text: string }) {
  return <p className="px-4 py-16 text-center text-sm text-slate-500">{text}</p>;
}
