import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Shield, Mail, Lock, ArrowRight } from 'lucide-react';

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: { pathname: string } })?.from?.pathname ?? '/';

  const [email, setEmail] = useState('admin@local.test');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await login(email, password);
      navigate(from, { replace: true });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="on-dark">
      <div className="fx-backdrop" />
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="w-full max-w-md">
          <div className="panel overflow-hidden">
            <div className="relative border-b border-hairline bg-white/[0.02] px-8 py-8 text-center">
              <div className="pointer-events-none absolute inset-x-0 -top-24 h-40 bg-primary/10 blur-3xl" />
              <div className="relative mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-grad-brand text-white shadow-glow-lg">
                <Shield className="h-7 w-7" />
              </div>
              <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.22em] text-primary">Access Terminal</p>
              <h1 className="font-display text-2xl font-extrabold tracking-tight">Sign in</h1>
              <p className="mt-1 text-sm text-inkdim">Leak Scanner Command Center</p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-5 px-7 py-7">
              {error && (
                <div className="rounded-xl border border-neon-red/40 bg-neon-red/10 px-4 py-3 text-sm text-neon-red">
                  {error}
                </div>
              )}

              <label className="group relative block">
                <span className="field-label">Email</span>
                <span className="pointer-events-none absolute left-4 top-[38px] text-inkdim transition-colors duration-200 group-focus-within:text-primary">
                  <Mail className="h-4 w-4" />
                </span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="field pl-11"
                  placeholder="you@example.com"
                  required
                />
              </label>

              <label className="group relative block">
                <span className="field-label">Password</span>
                <span className="pointer-events-none absolute left-4 top-[38px] text-inkdim transition-colors duration-200 group-focus-within:text-primary">
                  <Lock className="h-4 w-4" />
                </span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="field pl-11"
                  placeholder="••••••••"
                  required
                />
              </label>

              <button
                type="submit"
                disabled={isSubmitting}
                className="btn-primary w-full"
              >
                {isSubmitting ? (
                  <>
                    <span className="h-4 w-4 animate-spin-fast rounded-full border-2 border-white/30 border-t-white" />
                    Signing in…
                  </>
                ) : (
                  <>
                    Sign in <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </button>
            </form>
          </div>

          <p className="mt-4 text-center text-xs text-inkdim/60">
            First run? Use the setup wizard at <code className="text-primary-hover">/setup</code>.
          </p>
        </div>
      </div>
    </div>
  );
}
