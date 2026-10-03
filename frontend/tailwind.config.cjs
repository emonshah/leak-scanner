/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{tsx,ts,jsx,js}'],
  theme: {
    extend: {
      colors: {
        // Brand ramp — cyan primary into violet secondary.
        primary: {
          DEFAULT: '#22d3ee',
          hover: '#67e8f9',
          deep: '#0891b2',
          soft: 'rgba(34,211,238,0.12)',
          border: 'rgba(34,211,238,0.38)',
        },
        accent: '#a855f7',
        neon: {
          pink: '#f472b6',
          amber: '#fbbf24',
          green: '#34d399',
          red: '#fb7185',
        },
        // Surfaces for the dark UI.
        void: '#07070c',
        surface: '#0e0e19',
        raised: '#14141f',
        glassy: 'rgba(13,13,24,0.66)',
        hairline: '#1e1e30',
        hairline2: '#2b2b45',
        ink: '#e9edfb',
        inkdim: '#8a92ae',
        // Severity (kept from the original scale).
        emergency: '#ef4444',
        high: '#f59e0b',
        medium: '#eab308',
        low: '#6b7280',
      },
      fontFamily: {
        display: ['Orbitron', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(34,211,238,0.35), 0 0 26px -6px rgba(34,211,238,0.55)',
        'glow-lg': '0 0 44px -10px rgba(34,211,238,0.5)',
        violet: '0 0 0 1px rgba(168,85,247,0.35), 0 0 26px -6px rgba(168,85,247,0.55)',
        panel: '0 2px 6px rgba(0,0,0,0.5), 0 24px 56px -20px rgba(0,0,0,0.95)',
      },
      backgroundImage: {
        'grad-brand': 'linear-gradient(135deg, #0891b2 0%, #6d28d9 100%)',
        'grad-neon': 'linear-gradient(135deg, #22d3ee 0%, #a855f7 100%)',
        'grad-hot': 'linear-gradient(135deg, #a855f7 0%, #f472b6 100%)',
        'grad-fill': 'linear-gradient(135deg, #0a7c9e 0%, #6d28d9 100%)',
        'grad-fill-hi': 'linear-gradient(135deg, #0a7c9e 0%, #7c3aed 100%)',
        aurora:
          'radial-gradient(1100px 640px at 12% -10%, rgba(34,211,238,0.16), transparent 62%), radial-gradient(1000px 620px at 90% 0%, rgba(168,85,247,0.16), transparent 64%), radial-gradient(900px 620px at 50% 110%, rgba(244,114,182,0.10), transparent 62%)',
        grid: 'linear-gradient(rgba(148,163,184,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.05) 1px, transparent 1px)',
      },
      keyframes: {
        floaty: { '0%,100%': { transform: 'translateY(0)' }, '50%': { transform: 'translateY(-4px)' } },
        pulseRing: { '0%,100%': { opacity: '1' }, '50%': { opacity: '0.35' } },
        spinSlow: { to: { transform: 'rotate(360deg)' } },
        riseIn: { from: { opacity: '0', transform: 'translateY(10px)' }, to: { opacity: '1', transform: 'none' } },
        sweep: { from: { transform: 'translateY(-140px)' }, to: { transform: 'translateY(100%)' } },
        sweepX: { from: { transform: 'translateX(-100%)' }, to: { transform: 'translateX(100%)' } },
        blink: { '50%': { opacity: '0' } },
      },
      animation: {
        floaty: 'floaty 6s ease-in-out infinite',
        'pulse-ring': 'pulseRing 3s ease-in-out infinite',
        'spin-slow': 'spinSlow 26s linear infinite',
        'spin-fast': 'spin 0.9s linear infinite',
        'rise-in': 'riseIn 0.35s cubic-bezier(0.22,1,0.36,1) both',
        sweep: 'sweep 5.5s linear infinite',
        'sweep-x': 'sweepX 1.6s ease-in-out infinite',
        blink: 'blink 1s step-end infinite',
      },
    },
  },
  plugins: [],
}