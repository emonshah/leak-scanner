import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useSetup } from '@/hooks/useSetup';
import { Login } from '@/pages/Login';
import { SetupWizard } from '@/pages/SetupWizard';
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

function SetupGate({ children }: { children: JSX.Element }) {
  const { configured, isLoading } = useSetup();
  if (isLoading) return <div className="p-6 text-sm text-inkdim">Checking configuration…</div>;
  if (!configured) return <Navigate to="/setup" replace />;
  return children;
}

// Inverse gate for /login: when the DB is gone (tables dropped) the app is
// unconfigured, so showing a dead login form is wrong — bounce to /setup.
function LoginGate({ children }: { children: JSX.Element }) {
  const { configured, isLoading } = useSetup();
  if (isLoading) return <div className="p-6 text-sm text-inkdim">Checking configuration…</div>;
  if (configured === false) return <Navigate to="/setup" replace />;
  return children;
}

function Shell() {
  return (
    <SetupGate>
      <RequireAuth>
        <Layout />
      </RequireAuth>
    </SetupGate>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginGate><Login /></LoginGate>} />
      <Route path="/setup" element={<SetupWizard />} />
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
