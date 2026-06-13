import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0a0a0f',
        surface: '#111116',
        raised: '#16161d',
        border: '#26262e',
        text: '#e7e7ea',
        muted: '#8b8b93',
        accent: { DEFAULT: '#6366f1', hover: '#818cf8' },
        green: '#22c55e',
        amber: '#eab308',
        red: '#ef4444',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
} satisfies Config
