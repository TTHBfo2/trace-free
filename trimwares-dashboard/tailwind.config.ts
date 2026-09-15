import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        bg:      '#0a0a0a',
        surface: '#111111',
        border:  '#1f1f1f',
        muted:   '#888888',
        // Do NOT redeclare `green`/`blue`/`yellow`/`red` here as flat strings.
        // Doing so replaces Tailwind's entire numbered palette for that name,
        // so `text-green-400`, `bg-green-500/50`, `text-red-400` etc. stop
        // generating any CSS at all and silently fall back to inherited
        // color. That shipped in 1.5.3: ~73 such classes across the free
        // dashboard were no-ops (every "green" accent rendered white), and
        // the 1.5.4 Developer CTA button — text-black on a bg-green-400 that
        // didn't exist — rendered black-on-black, i.e. invisible. The removed
        // values were Tailwind's own 500 shades anyway. Use the numbered
        // palette (green-500 = #22c55e) or add a NON-colliding semantic name
        // (Developer's config uses success/warning/danger for this reason).
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'JetBrains Mono', 'Fira Code', 'monospace'],
      },
    },
  },
  plugins: [],
};
export default config;
