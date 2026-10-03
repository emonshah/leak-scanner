import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { apiFetch, apiPost } from '@/api/client';
import { useSetup } from '@/hooks/useSetup';

interface DbForm {
  dbHost: string;
  dbPort: string;
  dbUser: string;
  dbPassword: string;
  dbName: string;
}

interface AdminForm {
  adminEmail: string;
  adminName: string;
  adminPassword: string;
  authSecret: string;
  appUrl: string;
}

type Step = 'db' | 'admin' | 'progress' | 'complete';

/* ---------- presentational pieces ---------- */

const STAGES = [
  { id: 'db', label: 'Database', hint: 'MySQL connection' },
  { id: 'admin', label: 'Admin', hint: 'Owner account' },
  { id: 'complete', label: 'Complete', hint: 'Restart & go' },
] as const;

function Icon({ name, className = 'h-4 w-4' }: { name: string; className?: string }) {
  const paths: Record<string, React.ReactNode> = {
    db: (
      <>
        <ellipse cx="12" cy="5.5" rx="8" ry="3" />
        <path d="M4 5.5v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
        <path d="M4 11.5v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
      </>
    ),
    user: (
      <>
        <circle cx="12" cy="8" r="3.5" />
        <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
      </>
    ),
    key: (
      <>
        <circle cx="8" cy="12" r="4" />
        <path d="M12 12h9M18 12v3.5M15 12v2.5" />
      </>
    ),
    shield: (
      <>
        <path d="M12 3 5 6v6c0 4.2 2.9 7.9 7 9 4.1-1.1 7-4.8 7-9V6l-7-3Z" />
        <path d="m9 12 2 2 4-4" />
      </>
    ),
    check: <path d="m5 13 4 4L19 7" />,
    globe: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3c2.5 2.7 2.5 15 0 18M12 3c-2.5 2.7-2.5 15 0 18" />
      </>
    ),
    bolt: <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" />,
    spark: (
      <>
        <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
        <path d="M12 8.5 13.8 12 12 15.5 10.2 12 12 8.5Z" />
      </>
    ),
    terminal: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="m7 9 3 3-3 3M13 15h4" />
      </>
    ),
    alert: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v5M12 16h.01" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 12a8 8 0 1 1-2.6-5.9" />
        <path d="M20 4v4h-4" />
      </>
    ),
    arrowRight: <path d="M5 12h14M13 6l6 6-6 6" />,
    arrowLeft: <path d="M19 12H5M11 18l-6-6 6-6" />,
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

function Field({
  icon,
  label,
  hint,
  children,
}: {
  icon: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="group relative block">
      <span className="field-label">{label}</span>
      <span className="pointer-events-none absolute left-4 top-[38px] text-inkdim transition-colors duration-200 group-focus-within:text-primary">
        <Icon name={icon} />
      </span>
      <div className="[&_input]:pl-11">{children}</div>
      {hint && <span className="mt-1.5 block text-xs text-inkdim/80">{hint}</span>}
    </label>
  );
}

function Banner({
  tone,
  children,
}: {
  tone: 'error' | 'warn' | 'info';
  children: React.ReactNode;
}) {
  const tones = {
    error: 'border-neon-red/40 bg-neon-red/10 text-neon-red',
    warn: 'border-neon-amber/40 bg-neon-amber/10 text-neon-amber',
    info: 'border-primary/40 bg-primary/10 text-primary-hover',
  } as const;
  return (
    <div className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-sm ${tones[tone]}`} role="alert">
      <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

/* ---------- page ---------- */

export function SetupWizard() {
  const { configured, isLoading: setupLoading } = useSetup();
  const [step, setStep] = useState<Step>('db');
  const [dbForm, setDbForm] = useState<DbForm>({
    dbHost: 'localhost',
    dbPort: '3306',
    dbUser: '',
    dbPassword: '',
    dbName: 'leak_scanner',
  });
  const [adminForm, setAdminForm] = useState<AdminForm>({
    adminEmail: 'admin@scanner.local',
    adminName: 'Admin',
    adminPassword: '',
    authSecret: '',
    appUrl: 'http://localhost:3000',
  });
  const [error, setError] = useState<string | null>(null);
  const [isValidatingDb, setIsValidatingDb] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  const [progressLog, setProgressLog] = useState<string[]>([]);

  // DB already healthy (e.g. user reopens /setup after configuring) →
  // don't strand them on the wizard, forward to sign in.
  if (!setupLoading && configured) {
    return <Navigate to="/login" replace />;
  }

  const handleDbChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setDbForm({ ...dbForm, [e.target.name]: e.target.value });
  };

  const handleAdminChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setAdminForm({ ...adminForm, [e.target.name]: e.target.value });
  };

  const validateDb = async () => {
    setIsValidatingDb(true);
    setError(null);
    try {
      const payload = {
        dbHost: dbForm.dbHost,
        dbPort: Number(dbForm.dbPort),
        dbUser: dbForm.dbUser,
        dbPassword: dbForm.dbPassword,
        dbName: dbForm.dbName,
      };
      await apiPost<{ ok: boolean }>('/api/setup/validate-db', payload);
      setStep('admin');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsValidatingDb(false);
    }
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    setError(null);
    setStep('progress');
    setProgressLog([]);
    try {
      const payload = {
        dbHost: dbForm.dbHost,
        dbPort: Number(dbForm.dbPort),
        dbUser: dbForm.dbUser,
        dbPassword: dbForm.dbPassword,
        dbName: dbForm.dbName,
        adminEmail: adminForm.adminEmail,
        adminName: adminForm.adminName,
        adminPassword: adminForm.adminPassword,
        authSecret: adminForm.authSecret,
        appUrl: adminForm.appUrl,
      };
      const data = await apiPost<{ ok: boolean; progress?: string[]; needsRestart?: boolean }>(
        '/api/setup',
        payload,
      );
      if (data.progress) setProgressLog(data.progress);
      setStep('complete');
    } catch (e: unknown) {
      setError((e as Error).message);
      setStep('admin');
    } finally {
      setIsSubmitting(false);
    }
  };

  const generateSecret = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()';
    let secret = '';
    for (let i = 0; i < 48; i++) {
      secret += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    setAdminForm({ ...adminForm, authSecret: secret });
  };

  const handleRestart = async () => {
    setIsRestarting(true);
    setRestartError(null);
    try {
      await apiPost<{ ok: boolean; message: string }>('/api/setup/restart', {});
      // The server exits here and respawns (~a few seconds). Don't jump to
      // /login on a fixed timer — poll until the fresh process reports
      // configured:true, otherwise the login gate bounces straight back.
      const deadline = Date.now() + 45000;
      let ready = false;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const s = await apiFetch<{ ok: boolean; configured: boolean }>('/api/setup/status');
          if (s.configured) {
            ready = true;
            break;
          }
        } catch {
          /* backend still respawning — keep waiting */
        }
      }
      if (!ready) {
        setRestartError('Server ekhono back ase nai. Terminal e backend cholche kina dekhen, tarpor Login page e jan.');
        setIsRestarting(false);
        return;
      }
      window.location.href = '/login';
    } catch (e) {
      setRestartError((e as Error).message);
      setIsRestarting(false);
    }
  };

  const stageIndex = step === 'db' ? 0 : step === 'admin' ? 1 : 2;
  const dbFilled = Boolean(dbForm.dbHost && dbForm.dbUser && dbForm.dbName);
  const adminFilled =
    Boolean(adminForm.adminEmail) &&
    Boolean(adminForm.adminName) &&
    Boolean(adminForm.adminPassword) &&
    adminForm.adminPassword.length >= 8 &&
    Boolean(adminForm.authSecret) &&
    adminForm.authSecret.length >= 16;

  /* ---------- boot / restart ---------- */
  if (step === 'complete') {
    return (
      <div className="on-dark">
        <div className="fx-backdrop" />
        <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col justify-center px-5 py-14">
          <div className="panel animate-rise-in overflow-hidden">
            <div className="relative overflow-hidden border-b border-hairline bg-white/[0.02] px-8 py-10 text-center">
              <div className="pointer-events-none absolute inset-x-0 -top-24 h-40 bg-primary/10 blur-3xl" />
              <div className="relative mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-neon-green/40 bg-neon-green/10 text-neon-green shadow-[0_0_34px_-8px_rgba(52,211,153,0.7)]">
                <Icon name="check" className="h-8 w-8" />
              </div>
              <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.22em] text-neon-green">
                Setup Complete
              </p>
              <h1 className="font-display text-3xl font-extrabold tracking-tight">You&rsquo;re configured</h1>
              <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-inkdim">
                The database schema is in place and the admin user has been seeded.
              </p>
            </div>

            <div className="space-y-5 px-8 py-8">
              {progressLog.length > 0 && (
                <div className="console">
                  <div className="console-bar">
                    <Icon name="terminal" className="h-3.5 w-3.5" />
                    setup.log
                  </div>
                  <div className="console-body">
                    {progressLog.map((line, i) => {
                      const failed = /FAILED|Error/i.test(line);
                      return (
                        <div
                          key={i}
                          className={[
                            'flex animate-rise-in gap-2.5',
                            failed ? 'text-neon-red' : 'text-ink',
                          ].join(' ')}
                        >
                          <span className={failed ? 'text-neon-red' : 'text-neon-green'}>
                            {failed ? '×' : '✓'}
                          </span>
                          <span>{line}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <Banner tone="warn">
                The server needs a restart to load the new configuration. This takes about a second.
              </Banner>

              {isRestarting && (
                <div className="flex items-center gap-4 rounded-xl border border-primary/40 bg-primary/10 px-4 py-4">
                  <span className="h-6 w-6 shrink-0 animate-spin-fast rounded-full border-2 border-primary/30 border-t-primary" />
                  <div>
                    <p className="text-sm font-medium text-primary-hover">Restarting server…</p>
                    <p className="text-xs text-inkdim">Redirecting you to sign in.</p>
                  </div>
                </div>
              )}

              {restartError && <Banner tone="error">{restartError}</Banner>}

              <div className="flex flex-col gap-3 sm:flex-row">
                <button onClick={handleRestart} disabled={isRestarting} className="btn-primary flex-1">
                  {isRestarting ? (
                    <>
                      <span className="h-4 w-4 animate-spin-fast rounded-full border-2 border-white/30 border-t-white" />
                      Restarting…
                    </>
                  ) : (
                    <>
                      <Icon name="refresh" />
                      Restart Server
                    </>
                  )}
                </button>
                <button onClick={() => { setStep('admin'); setError(null); }} className="btn-ghost flex-1">
                  Back to Form
                </button>
              </div>

              <p className="text-center text-xs text-inkdim/70">
                Or stop the server manually (Ctrl+C) and start it again.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* ---------- form ---------- */
  return (
    <div className="on-dark">
      <div className="fx-backdrop" />

      <div className="mx-auto w-full max-w-6xl px-5 py-10 sm:py-16">
        {/* ---------- hero ---------- */}
        <header className="mb-10 text-center">
          <div className="relative mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-grad-brand text-white shadow-glow-lg">
            <Icon name="spark" className="h-8 w-8" />
            <span className="absolute -inset-2 animate-spin-slow rounded-[26px] border border-dashed border-primary/30" />
          </div>
          <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.22em] text-primary">
            First run configuration
          </p>
          <h1 className="bg-grad-neon bg-clip-text font-display text-4xl font-extrabold tracking-tight text-transparent sm:text-5xl">
            Setup Wizard
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-inkdim">
            Connect your MySQL instance and create the owner account. Everything runs locally &mdash; nothing
            leaves this machine.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            <span className="chip">
              <Icon name="shield" className="h-3.5 w-3.5 text-neon-green" /> Local only
            </span>
            <span className="chip">
              <Icon name="bolt" className="h-3.5 w-3.5 text-primary" /> Deterministic
            </span>
            <span className="chip">
              <Icon name="db" className="h-3.5 w-3.5 text-accent" /> MySQL 8+
            </span>
          </div>
        </header>

        {/* ---------- stepper ---------- */}
        <ol className="panel mx-auto mb-8 grid max-w-3xl grid-cols-1 overflow-hidden sm:grid-cols-3">
          {STAGES.map((s, i) => {
            const state = i < stageIndex ? 'done' : i === stageIndex ? 'now' : 'todo';
            return (
              <li
                key={s.id}
                className={[
                  'relative flex items-center gap-3.5 px-6 py-4 transition-colors duration-300',
                  i > 0 && 'sm:border-l sm:border-hairline',
                  i > 0 && 'border-t border-hairline sm:border-t-0',
                  state === 'now' ? 'bg-primary/[0.07]' : '',
                ].join(' ')}
              >
                <span
                  className={[
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border font-mono text-xs font-bold transition-all duration-300',
                    state === 'done' && 'border-neon-green/40 bg-neon-green/10 text-neon-green',
                    state === 'now' && 'border-primary/40 bg-grad-fill text-white shadow-glow',
                    state === 'todo' && 'border-hairline2 bg-white/[0.03] text-inkdim',
                  ].join(' ')}
                >
                  {state === 'done' ? <Icon name="check" className="h-3.5 w-3.5" /> : String(i + 1).padStart(2, '0')}
                </span>
                <span className="min-w-0">
                  <span
                    className={[
                      'block text-sm font-semibold',
                      state === 'done' && 'text-neon-green',
                      state === 'now' && 'text-primary-hover',
                      state === 'todo' && 'text-inkdim',
                    ].join(' ')}
                  >
                    {s.label}
                  </span>
                  <span className="block truncate text-xs text-inkdim/70">{s.hint}</span>
                </span>
                {state === 'now' && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-grad-neon shadow-glow" />}
              </li>
            );
          })}
        </ol>

        {/* ---------- body ---------- */}
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_19rem]">
          <section className="panel animate-rise-in overflow-hidden">
            {/* head */}
            <div className="relative border-b border-hairline bg-white/[0.02] px-7 py-6">
              <span className="absolute left-0 top-0 h-0.5 w-24 bg-grad-neon shadow-glow" />
              {step === 'db' ? (
                <>
                  <div className="flex items-center gap-3">
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
                      <Icon name="db" />
                    </span>
                    <div>
                      <h2 className="text-lg font-bold tracking-tight">Database connection</h2>
                      <p className="text-xs text-inkdim">Point the scanner at a MySQL instance</p>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-3">
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-accent/30 bg-accent/10 text-accent">
                      <Icon name="user" />
                    </span>
                    <div>
                      <h2 className="text-lg font-bold tracking-tight">Admin account</h2>
                      <p className="text-xs text-inkdim">Creates the workspace owner and token secret</p>
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* body */}
            <div className="space-y-5 px-7 py-7">
              {error && <Banner tone="error">{error}</Banner>}

              {step === 'db' && (
                <>
                  <div className="grid gap-5 sm:grid-cols-2">
                    <Field icon="globe" label="Host">
                      <input
                        type="text"
                        name="dbHost"
                        value={dbForm.dbHost}
                        onChange={handleDbChange}
                        className="field"
                        placeholder="localhost"
                        required
                      />
                    </Field>
                    <Field icon="bolt" label="Port">
                      <input
                        type="number"
                        name="dbPort"
                        value={dbForm.dbPort}
                        onChange={handleDbChange}
                        className="field"
                        placeholder="3306"
                        required
                      />
                    </Field>
                    <Field icon="db" label="Database name">
                      <input
                        type="text"
                        name="dbName"
                        value={dbForm.dbName}
                        onChange={handleDbChange}
                        className="field"
                        placeholder="leak_scanner"
                        required
                      />
                    </Field>
                    <Field icon="user" label="User">
                      <input
                        type="text"
                        name="dbUser"
                        value={dbForm.dbUser}
                        onChange={handleDbChange}
                        className="field"
                        placeholder="root"
                        required
                      />
                    </Field>
                    <Field icon="key" label="Password" hint="Leave empty if the account has no password.">
                      <input
                        type="password"
                        name="dbPassword"
                        value={dbForm.dbPassword}
                        onChange={handleDbChange}
                        className="field"
                        autoComplete="new-password"
                      />
                    </Field>
                  </div>

                  <div className="rounded-xl border border-primary/20 bg-primary/[0.06] px-4 py-3.5">
                    <p className="flex items-center gap-2 text-xs font-medium text-primary-hover">
                      <Icon name="spark" className="h-3.5 w-3.5" />
                      The schema is created automatically if it doesn&rsquo;t exist yet.
                    </p>
                  </div>

                  <button
                    onClick={validateDb}
                    disabled={isValidatingDb || !dbFilled}
                    className="btn-primary w-full"
                  >
                    {isValidatingDb ? (
                      <>
                        <span className="h-4 w-4 animate-spin-fast rounded-full border-2 border-white/30 border-t-white" />
                        Testing connection…
                      </>
                    ) : (
                      <>
                        <Icon name="bolt" />
                        Test Database Connection
                      </>
                    )}
                  </button>
                </>
              )}

              {step === 'admin' && (
                <>
                  <div className="grid gap-5 sm:grid-cols-2">
                    <Field icon="user" label="Email">
                      <input
                        type="email"
                        name="adminEmail"
                        value={adminForm.adminEmail}
                        onChange={handleAdminChange}
                        className="field"
                        required
                      />
                    </Field>
                    <Field icon="spark" label="Name">
                      <input
                        type="text"
                        name="adminName"
                        value={adminForm.adminName}
                        onChange={handleAdminChange}
                        className="field"
                        required
                      />
                    </Field>
                    <Field icon="key" label="Password" hint="At least 8 characters.">
                      <input
                        type="password"
                        name="adminPassword"
                        value={adminForm.adminPassword}
                        onChange={handleAdminChange}
                        className="field"
                        autoComplete="new-password"
                        required
                      />
                    </Field>
                    <Field icon="globe" label="App URL" hint="Used for links inside generated reports.">
                      <input
                        type="text"
                        name="appUrl"
                        value={adminForm.appUrl}
                        onChange={handleAdminChange}
                        className="field"
                        required
                      />
                    </Field>

                    <div className="sm:col-span-2">
                      <label className="block">
                        <span className="field-label">Auth secret</span>
                        <div className="flex gap-2">
                          <span className="pointer-events-none absolute left-4 top-[38px] text-inkdim transition-colors duration-200 peer-focus:hidden">
                            <Icon name="shield" />
                          </span>
                          <input
                            type="text"
                            name="authSecret"
                            value={adminForm.authSecret}
                            onChange={handleAdminChange}
                            className="field flex-1 pl-11 font-mono"
                            placeholder="Generate a secret to sign session tokens"
                            required
                          />
                          <button type="button" onClick={generateSecret} className="btn-ghost shrink-0">
                            Generate
                          </button>
                        </div>
                      </label>
                      <p className="mt-1.5 text-xs text-inkdim/80">
                        Minimum 16 characters. Used for signing session tokens.
                      </p>
                      <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/[0.06]">
                        <div
                          className="h-full rounded-full bg-grad-neon transition-all duration-500"
                          style={{ width: `${Math.min(100, (adminForm.authSecret.length / 32) * 100)}%` }}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col gap-3 sm:flex-row-reverse">
                    <button onClick={handleSubmit} disabled={isSubmitting || !adminFilled} className="btn-primary flex-1">
                      {isSubmitting ? (
                        <>
                          <span className="h-4 w-4 animate-spin-fast rounded-full border-2 border-white/30 border-t-white" />
                          Running setup…
                        </>
                      ) : (
                        <>
                          <Icon name="check" />
                          Run Setup
                        </>
                      )}
                    </button>
                    <button onClick={() => setStep('db')} disabled={isSubmitting} className="btn-ghost sm:w-32">
                      <Icon name="arrowLeft" />
                      Back
                    </button>
                  </div>
                </>
              )}

              {step === 'progress' && (
                <div className="flex flex-col items-center gap-6 py-12 text-center">
                  <span className="relative h-16 w-16 rounded-full border-2 border-hairline2 border-t-primary border-r-accent animate-spin-fast" />
                  <div>
                    <h3 className="font-display text-xl font-bold">Applying your configuration</h3>
                    <p className="mt-2 text-sm text-inkdim">Writing <code className="font-mono text-primary-hover">.env</code>, creating the schema and seeding the admin user…</p>
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* ---------- rail ---------- */}
          <aside className="space-y-5">
            <div className="panel p-6 transition-transform duration-300 hover:-translate-y-0.5">
              <h3 className="mb-4 text-[11px] font-bold uppercase tracking-[0.18em] text-inkdim">
                Configuration
              </h3>
              <dl className="space-y-3 font-mono text-xs">
                {[
                  ['Host', `${dbForm.dbHost}:${dbForm.dbPort}`],
                  ['Database', dbForm.dbName],
                  ['DB user', dbForm.dbUser || '—'],
                  ['Admin', adminForm.adminEmail],
                  ['App URL', adminForm.appUrl],
                ].map(([k, v]) => (
                  <div key={k} className="flex items-baseline justify-between gap-3">
                    <dt className="shrink-0 text-inkdim/70">{k}</dt>
                    <dd className="truncate text-ink" title={v}>{v}</dd>
                  </div>
                ))}
              </dl>
            </div>

            <div className="rounded-2xl border border-primary/30 bg-primary/[0.07] p-5">
              <p className="flex items-start gap-3 text-xs leading-relaxed text-inkdim">
                <Icon name="shield" className="mt-0.5 h-4 w-4 shrink-0 text-primary-hover" />
                <span>
                  <b className="text-ink">Your data never leaves this machine.</b> Credentials are written to{' '}
                  <code className="font-mono text-primary-hover">.env</code> and read only by the local server.
                </span>
              </p>
            </div>
          </aside>
        </div>

        <footer className="mt-10 flex flex-col items-center gap-2 text-center text-xs text-inkdim/60">
          <span>Leak Scanner · first-run configuration</span>
          <span>
            Config written to <code className="font-mono text-inkdim">.env</code> · schema managed by the local
            server
          </span>
        </footer>
      </div>
    </div>
  );
}
