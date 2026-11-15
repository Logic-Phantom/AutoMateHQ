import { BrowserRouter, Route, Routes } from 'react-router';
import { AppLayout } from '@/components/layout/AppLayout';
import { Loading } from '@/components/ui';
import { useSession } from './session';
import { LoginPage } from '@/pages/LoginPage';
import { OverviewPage } from '@/pages/OverviewPage';
import { ProjectsPage } from '@/pages/ProjectsPage';
import { ProjectDetailPage } from '@/pages/ProjectDetailPage';
import { RunsPage } from '@/pages/RunsPage';
import { IncidentsPage } from '@/pages/IncidentsPage';
import { MaintenancePage } from '@/pages/MaintenancePage';
import { PublicationsPage } from '@/pages/PublicationsPage';
import { UsagePage } from '@/pages/UsagePage';
import { NotificationsPage } from '@/pages/NotificationsPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { ReportPage } from '@/pages/ReportPage';
import { NotFoundPage } from '@/pages/NotFoundPage';

export function App() {
  const { session } = useSession();
  if (!session) return <Loading label="세션 확인 중…" />;
  if (!session.authenticated) return <LoginPage />;
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppLayout />}>
          <Route index element={<OverviewPage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="projects/:id" element={<ProjectDetailPage />} />
          <Route path="runs" element={<RunsPage />} />
          <Route path="incidents" element={<IncidentsPage />} />
          <Route path="maintenance" element={<MaintenancePage />} />
          <Route path="publications" element={<PublicationsPage />} />
          <Route path="usage" element={<UsagePage />} />
          <Route path="notifications" element={<NotificationsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="reports/:date" element={<ReportPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
