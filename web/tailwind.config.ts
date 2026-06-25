import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#1a0f2e',
        surface: '#241640',
        raised: '#2e1b52',
        border: '#3a2a5c',
        text: '#f4f0ff',
        muted: '#a99bc4',
        // accent = blush pink (fills/active); accent-hover = sky blue (hover/active transition)
        accent: { DEFAULT: '#ff8fc0', hover: '#38bdf8' },
        green: '#34d399',
        amber: '#fbbf24',
        red: '#f87171',
      },
      borderRadius: {
        panel: '18px',
        control: '14px',
        pill: '9999px',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
} satisfies Config
