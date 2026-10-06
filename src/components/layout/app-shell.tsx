import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import {
  BookOpenCheck,
  ClipboardCheck,
  GitCompareArrows,
  LayoutDashboard,
  Network,
  PackageCheck,
} from 'lucide-react';
import { cn } from '../../lib/utils';

const navigation = [
  { to: '/', label: '契约工作台', icon: LayoutDashboard, exact: true },
  { to: '/review', label: '批量评审', icon: ClipboardCheck, exact: false },
  { to: '/releases', label: '版本发布', icon: PackageCheck, exact: false },
  { to: '/reports', label: '变更报告', icon: BookOpenCheck, exact: false },
] as const;

export function AppShell() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-slate-800 bg-slate-950 text-slate-100 lg:flex lg:flex-col">
        <div className="flex h-16 items-center gap-3 border-b border-slate-800 px-5">
          <div className="grid h-9 w-9 place-items-center rounded-md border border-sky-700 bg-sky-950">
            <GitCompareArrows className="h-5 w-5 text-sky-300" />
          </div>
          <div>
            <strong className="block text-sm">API 契约审查</strong>
            <span className="text-[10px] uppercase tracking-wide text-slate-400">
              Compatibility Gate
            </span>
          </div>
        </div>

        <nav className="flex-1 space-y-1 p-3" aria-label="主导航">
          {navigation.map((item) => {
            const Icon = item.icon;
            const active = item.exact ? pathname === item.to : pathname.startsWith(item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  'flex items-center gap-3 rounded-md px-3 py-2.5 text-sm text-slate-300 transition-colors hover:bg-slate-900 hover:text-white',
                  active && 'bg-sky-950 text-white ring-1 ring-inset ring-sky-800',
                )}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-slate-800 p-4">
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <Network className="h-4 w-4 text-emerald-400" />
            <span>本地契约仓库已连接</span>
          </div>
          <p className="mt-2 text-[11px] leading-5 text-slate-500">
            数据保存在浏览器 localStorage，发布版本冻结后不可覆盖。
          </p>
        </div>
      </aside>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur">
          <div className="flex min-h-16 items-center justify-between gap-4 px-4 sm:px-6">
            <div className="flex items-center gap-3 lg:hidden">
              <GitCompareArrows className="h-5 w-5 text-sky-800" />
              <strong className="text-sm">API 契约审查</strong>
            </div>
            <div className="hidden text-xs text-slate-500 lg:block">
              正式版本发布前执行兼容性门禁、调用方影响确认与迁移方案检查
            </div>
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              <span className="text-xs text-slate-600">评审服务正常</span>
            </div>
          </div>
          <nav
            className="flex gap-1 overflow-x-auto border-t border-slate-100 px-2 py-1 lg:hidden"
            aria-label="移动端导航"
          >
            {navigation.map((item) => {
              const active = item.exact ? pathname === item.to : pathname.startsWith(item.to);
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={cn(
                    'shrink-0 rounded-md px-3 py-2 text-xs text-slate-600',
                    active && 'bg-sky-50 font-medium text-sky-900',
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </header>

        <main className="mx-auto max-w-[1500px] p-4 sm:p-6 lg:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
