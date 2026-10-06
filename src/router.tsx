import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
} from '@tanstack/react-router';
import { AppShell } from './components/layout/app-shell';
import { ContractDetailPage } from './pages/contract-detail-page';
import { DashboardPage } from './pages/dashboard-page';
import { ReleasesPage } from './pages/releases-page';
import { ReportsPage } from './pages/reports-page';
import { ReviewQueuePage } from './pages/review-queue-page';

const rootRoute = createRootRoute({
  component: AppShell,
  notFoundComponent: () => (
    <div className="rounded-lg border border-slate-200 bg-white px-6 py-20 text-center">
      <h1 className="text-xl font-semibold">页面不存在</h1>
      <p className="mt-2 text-sm text-slate-500">请求的工作区路径无效。</p>
      <Link to="/" className="mt-5 inline-flex text-sm font-medium text-sky-800">
        返回契约工作台
      </Link>
    </div>
  ),
});

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: DashboardPage,
});

const contractDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/contracts/$contractId',
  component: ContractDetailPage,
});

const reviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/review',
  component: ReviewQueuePage,
});

const releasesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/releases',
  component: ReleasesPage,
});

const reportsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reports',
  component: ReportsPage,
});

const routeTree = rootRoute.addChildren([
  dashboardRoute,
  contractDetailRoute,
  reviewRoute,
  releasesRoute,
  reportsRoute,
]);

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  scrollRestoration: true,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
