import { useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { apiPost, apiPatch } from '@/api/client';
import type { ProfileUser } from '@/types';
import { User, Key, Save } from 'lucide-react';

export function Settings() {
  const { user } = useAuth();
  const [section, setSection] = useState<'profile' | 'password' | 'scanner'>('profile');
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleProfileSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      await apiPatch<{ ok: boolean; user: ProfileUser }>('/api/auth/profile', { displayName: displayName.trim() });
      setSuccess('Profile updated');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handlePasswordSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      await apiPost('/api/auth/password', { current: currentPassword, next: newPassword });
      setSuccess('Password updated');
      setCurrentPassword('');
      setNewPassword('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <div className="text-[11px] font-bold uppercase tracking-[0.22em] text-primary">Account</div>
        <h1 className="font-display text-3xl font-extrabold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-inkdim">Manage your profile and scanner configuration.</p>
      </div>

      <div className="flex gap-2 border-b border-hairline">
        {[
          { key: 'profile', label: 'Profile', icon: User },
          { key: 'password', label: 'Password', icon: Key },
          { key: 'scanner', label: 'Scanner', icon: Save },
        ].map((s) => {
          const Icon = s.icon;
          return (
            <button
              key={s.key}
              onClick={() => setSection(s.key as typeof section)}
              className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
                section === s.key
                  ? 'border-primary text-primary-hover'
                  : 'border-transparent text-inkdim hover:text-ink'
              }`}
            >
              <Icon className="h-4 w-4" /> {s.label}
            </button>
          );
        })}
      </div>

      {error && (
        <div className="rounded-xl border border-neon-red/40 bg-neon-red/10 px-4 py-3 text-sm text-neon-red">
          {error}
        </div>
      )}
      {success && (
        <div className="rounded-xl border border-neon-green/40 bg-neon-green/10 px-4 py-3 text-sm text-neon-green">
          {success}
        </div>
      )}

      {section === 'profile' && (
        <form onSubmit={handleProfileSave} className="panel p-6">
          <h2 className="font-display text-lg font-bold tracking-tight">Profile</h2>
          <div className="mt-5 space-y-4">
            <div>
              <label className="field-label">Display Name</label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="field"
              />
            </div>
            <div>
              <label className="field-label">Email</label>
              <input
                type="text"
                value={user?.email ?? ''}
                disabled
                className="field opacity-60"
              />
            </div>
            <button type="submit" disabled={isSubmitting} className="btn-primary">
              {isSubmitting ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      )}

      {section === 'password' && (
        <form onSubmit={handlePasswordSave} className="panel p-6">
          <h2 className="font-display text-lg font-bold tracking-tight">Change Password</h2>
          <div className="mt-5 space-y-4">
            <div>
              <label className="field-label">Current Password</label>
              <input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="field"
                required
              />
            </div>
            <div>
              <label className="field-label">New Password</label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="field"
                minLength={8}
                required
              />
            </div>
            <button type="submit" disabled={isSubmitting} className="btn-primary">
              {isSubmitting ? 'Updating…' : 'Update Password'}
            </button>
          </div>
        </form>
      )}

      {section === 'scanner' && (
        <div className="panel p-6">
          <h2 className="font-display text-lg font-bold tracking-tight">Scanner Config</h2>
          <p className="mt-2 text-sm text-inkdim">
            Scanner configuration is managed via environment variables on the server. See{' '}
            <code className="rounded bg-white/[0.06] px-1 py-0.5 text-xs text-primary-hover">.env.example</code>.
          </p>
        </div>
      )}
    </div>
  );
}
