import { useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import {
  Activity,
  AlertOctagon,
  Bell,
  Bot,
  FolderGit2,
  LayoutDashboard,
  LogOut,
  Menu,
  Megaphone,
  Receipt,
  Settings,
  X,
} from 'lucide-react';
import { useSession } from '@/app/session';
import { cx, SampleBanner } from '@/components/ui';

const NAV = [
  { to: '/', label: '대시보드', Icon: LayoutDashboard, end: true },
  { to: '/projects', label: '프로젝트', Icon: FolderGit2 },
  { to: '/runs', label: '실행 이력', Icon: Activity },
  { to: '/incidents', label: '장애 관리', Icon: AlertOctagon },
  { to: '/maintenance', label: 'AI 유지보수', Icon: Bot },
  { to: '/publications', label: '콘텐츠 게시', Icon: Megaphone },
  { to: '/usage', label: '비용·사용량', Icon: Receipt },
  { to: '/notifications', label: '알림', Icon: Bell },
  { to: '/settings', label: '연동 설정', Icon: Settings },
];

export function AppLayout() {
  const { session, logout } = useSession();
  const [open, setOpen] = useState(false);
  const nav = (
    <nav aria-label="주 메뉴" className="space-y-0.5">
      {NAV.map(({ to, label, Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          onClick={() => setOpen(false)}
          className={({ isActive }) =>
            cx(
              'relative flex items-center gap-2.5 rounded-md px-2.5 py-[7px] text-label transition-colors',
              isActive
                ? 'bg-sunken font-semibold text-ink before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-brand'
                : 'text-ink-soft hover:bg-sunken hover:text-ink',
            )
          }
        >
          <Icon className="size-4" aria-hidden />
          {label}
        </NavLink>
      ))}
    </nav>
  );
  return (
    <div className="min-h-screen">
      {session?.mode === 'demo' && <SampleBanner />}
      <div className="flex">
        <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-line bg-surface px-3 py-4 md:flex">
          <Brand />
          <div className="mt-5 flex-1">{nav}</div>
          <LogoutButton onLogout={logout} />
        </aside>
        <div className="min-w-0 flex-1">
          <header className="flex items-center justify-between border-b border-line bg-surface px-4 py-2.5 md:hidden">
            <Brand />
            <button type="button" aria-label={open ? '메뉴 닫기' : '메뉴 열기'} aria-expanded={open} onClick={() => setOpen(!open)} className="rounded-md p-1.5 hover:bg-sunken">
              {open ? <X className="size-5" /> : <Menu className="size-5" />}
            </button>
          </header>
          {open && (
            <div className="border-b border-line bg-surface px-3 py-3 md:hidden">
              {nav}
              <div className="mt-2">
                <LogoutButton onLogout={logout} />
              </div>
            </div>
          )}
          <main className="mx-auto max-w-7xl px-4 py-6 md:px-8">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2 px-1">
      <img src="/icon.webp" alt="" className="size-7 rounded-md" />
      <span className="text-sm font-semibold tracking-tight">AI Automation HQ</span>
    </div>
  );
}

function LogoutButton({ onLogout }: { onLogout: () => Promise<void> }) {
  return (
    <button type="button" onClick={() => void onLogout()} className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-ink-soft hover:bg-sunken hover:text-ink">
      <LogOut className="size-4" aria-hidden /> 로그아웃
    </button>
  );
}
