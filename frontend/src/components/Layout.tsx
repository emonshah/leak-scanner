import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { LayoutDashboard, Globe, Settings, LogOut, Menu, X, Shield, PanelLeftClose, PanelLeftOpen, ArrowDownToLine } from 'lucide-react';
import { UpdateBanner } from '@/components/UpdateBanner';
import { apiFetch } from '@/api/client';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/websites', label: 'Websites', icon: Globe },
  { to: '/updates', label: 'Updates', icon: ArrowDownToLine },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export function Layout() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sidebar-collapsed') === '1');
  const [hasUpdate, setHasUpdate] = useState(false);
  // Re-check on every navigation (server caches GitHub for 24h, so this is
  // cheap and keeps the dot fresh after an update completes elsewhere).
  useEffect(() => {
    let off = false;
    void (async () => {
      try {
        const s = await apiFetch<{ ok: boolean; needsUpdate: boolean }>('/api/updates/status');
        if (!off) setHasUpdate(s.needsUpdate);
      } catch {
        /* silent — badge is best-effort */
      }
    })();
    return () => {
      off = true;
    };
  }, [location.pathname]);
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      localStorage.setItem('sidebar-collapsed', c ? '0' : '1');
      return !c;
    });
  };

  return (
    <div className="app-shell">
      <div className="fx-backdrop" />
      <div className="fx-sheen" />

      <div className="flex min-h-screen">
        {/* Desktop sidebar */}
        <aside className={`hidden shrink-0 flex-col border-r border-hairline bg-void/60 backdrop-blur-xl transition-all lg:flex ${collapsed ? 'w-[72px]' : 'w-56'}`}>
          <div className={`flex items-center gap-3 border-b border-hairline px-5 py-5 ${collapsed ? 'justify-center px-0' : ''}`}>
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-grad-brand text-white shadow-glow">
              <Shield className="h-5 w-5" />
            </div>
            {!collapsed && (
              <div>
                <div className="font-display text-lg font-bold tracking-tight">Leak Scanner</div>
                <div className="text-[10px] uppercase tracking-[0.2em] text-inkdim">Command Center</div>
              </div>
            )}
          </div>
          <nav className="flex-1 space-y-1 p-3">
            {NAV.map((item) => {
              const active = location.pathname === item.to;
              const Icon = item.icon;
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  title={collapsed ? item.label : undefined}
                  className={`relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${collapsed ? 'justify-center' : ''} ${
                    active
                      ? 'bg-primary/[0.12] text-primary-hover'
                      : 'text-inkdim hover:bg-white/[0.04] hover:text-ink'
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {!collapsed && item.label}
                  {!collapsed && active && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary shadow-glow" />}
                  {!collapsed && !active && hasUpdate && item.to === '/updates' && (
                    <span className="ml-auto flex h-2 w-2">
                      <span className="absolute h-2 w-2 animate-ping rounded-full bg-neon-green opacity-60" />
                      <span className="h-2 w-2 rounded-full bg-neon-green" />
                    </span>
                  )}
                  {collapsed && hasUpdate && item.to === '/updates' && (
                    <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-neon-green shadow-glow" />
                  )}
                </Link>
              );
            })}
          </nav>
          <div className="border-t border-hairline p-3">
            {!collapsed && <div className="mb-2 truncate text-xs text-inkdim">{user?.email}</div>}
            <button
              onClick={() => void logout()}
              title={collapsed ? 'Logout' : undefined}
              className={`btn-quiet w-full ${collapsed ? 'justify-center px-0' : 'justify-start'}`}
            >
              <LogOut className="h-4 w-4" /> {!collapsed && 'Logout'}
            </button>
          </div>
        </aside>

        {/* Mobile drawer */}
        {open && (
          <div className="fixed inset-0 z-40 lg:hidden">
            <div className="absolute inset-0 bg-void/80 backdrop-blur-sm" onClick={() => setOpen(false)} />
            <aside className="relative flex h-full w-72 max-w-[80%] flex-col border-r border-hairline bg-void/95">
              <div className="flex items-center justify-between border-b border-hairline px-5 py-5">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-grad-brand text-white shadow-glow">
                    <Shield className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="font-display text-lg font-bold tracking-tight">Leak Scanner</div>
                    <div className="text-[10px] uppercase tracking-[0.2em] text-inkdim">Command Center</div>
                  </div>
                </div>
                <button onClick={() => setOpen(false)} className="btn-quiet">
                  <X className="h-5 w-5" />
                </button>
              </div>
              <nav className="flex-1 space-y-1 p-3">
                {NAV.map((item) => {
                  const active = location.pathname === item.to;
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.to}
                      to={item.to}
                      onClick={() => setOpen(false)}
                      className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
                        active
                          ? 'bg-primary/[0.12] text-primary-hover'
                          : 'text-inkdim hover:bg-white/[0.04] hover:text-ink'
                      }`}
                    >
                      <Icon className="h-4 w-4" />
                      {item.label}
                      {hasUpdate && item.to === '/updates' && (
                        <span className="ml-auto h-2 w-2 rounded-full bg-neon-green shadow-glow" />
                      )}
                    </Link>
                  );
                })}
              </nav>
              <div className="border-t border-hairline p-3">
                <div className="mb-2 truncate text-xs text-inkdim">{user?.email}</div>
                <button
                  onClick={() => { void logout(); }}
                  className="btn-quiet w-full justify-start"
                >
                  <LogOut className="h-4 w-4" /> Logout
                </button>
              </div>
            </aside>
          </div>
        )}

        {/* Main column */}
        <main className="min-w-0 flex-1">
          <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-hairline bg-void/70 px-4 py-3 backdrop-blur-xl sm:px-6">
            <button onClick={() => setOpen(true)} className="btn-quiet lg:hidden">
              <Menu className="h-5 w-5" />
            </button>
            <button onClick={toggleCollapsed} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} className="btn-quiet hidden lg:flex">
              {collapsed ? <PanelLeftOpen className="h-5 w-5" /> : <PanelLeftClose className="h-5 w-5" />}
            </button>
            <div className="font-display text-sm font-semibold tracking-tight">
              {NAV.find((n) => n.to === location.pathname)?.label ?? 'Leak Scanner'}
            </div>
            <div className="ml-auto flex items-center gap-2">
              <UpdateBanner />
              <span className="hidden text-xs text-inkdim sm:inline">
                {user?.email}
              </span>
              <button onClick={() => void logout()} className="btn-quiet">
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          </header>
          <div className="p-4 sm:p-6"><Outlet /></div>
        </main>
      </div>
    </div>
  );
}