import { Badge } from '../ui/badge';
import { formatNumber } from '../../lib/utils';
import type { ApiConsumer } from '../../models/contract';

export function ConsumerTable({ consumers }: { consumers: ApiConsumer[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-left text-sm">
        <thead className="bg-slate-50 text-xs text-slate-500">
          <tr>
            <th className="px-3 py-3 font-medium">调用方</th>
            <th className="px-3 py-3 font-medium">团队</th>
            <th className="px-3 py-3 font-medium">环境</th>
            <th className="px-3 py-3 font-medium">客户端版本</th>
            <th className="px-3 py-3 font-medium">日均调用</th>
            <th className="px-3 py-3 font-medium">联系人</th>
          </tr>
        </thead>
        <tbody>
          {consumers.map((consumer) => (
            <tr key={consumer.id} className="border-t border-slate-100">
              <td className="px-3 py-3 font-medium text-slate-900">{consumer.name}</td>
              <td className="px-3 py-3 text-slate-700">{consumer.owner}</td>
              <td className="px-3 py-3">
                <Badge tone={consumer.environment === '生产' ? 'blue' : 'neutral'}>
                  {consumer.environment}
                </Badge>
              </td>
              <td className="px-3 py-3 font-mono text-xs text-slate-700">
                {consumer.clientVersion}
              </td>
              <td className="px-3 py-3 text-slate-700">{formatNumber(consumer.requestsPerDay)}</td>
              <td className="px-3 py-3 text-xs text-sky-800">{consumer.contact}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!consumers.length && (
        <p className="px-3 py-10 text-center text-sm text-slate-500">
          尚未登记调用方，发布前需要补充依赖清单。
        </p>
      )}
    </div>
  );
}
