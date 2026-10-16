import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Login } from '@/pages/Login';
import { Dashboard } from '@/pages/Dashboard';
import { Websites } from '@/pages/Websites';
import { ScanDetail } from '@/pages/ScanDetail';
import { ScanReport } from '@/pages/ScanReport';
import { Settings } from '@/pages/Settings';
import { Updates } from '@/pages/Updates';
import { Layout } from '@/components/Layout';

function RequireAuth({ children }: { children: JSX.Element }) {
  const { user, isLoading } = useAuth();
  const location = useLocation();
  if (isLoading) return <div className="p-6 text-sm text-inkdim">Loading…</div>;
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  return children;
}

function Shell() {
  return (
    <RequireAuth>
      <Layout />
    </RequireAuth>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      {/* Legacy wizard URL — configuration now lives in backend/.env. */}
      <Route path="/setup" element={<Navigate to="/login" replace />} />
      <Route element={<Shell />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/websites" element={<Websites />} />
        <Route path="/updates" element={<Updates />} />
        <Route path="/scans/:id" element={<ScanDetail />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
      {/* Printable client report: authenticated but outside the app shell
          (no sidebar — clean print / PDF). */}
      <Route path="/scans/:id/report" element={<RequireAuth><ScanReport /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
