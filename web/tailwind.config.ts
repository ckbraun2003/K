import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'rgb(from var(--bg) r g b / <alpha-value>)',
        'bg-deep': 'rgb(from var(--bg-deep) r g b / <alpha-value>)',
        surface: 'rgb(from var(--surface) r g b / <alpha-value>)',
        raised: 'rgb(from var(--raised) r g b / <alpha-value>)',
        border: 'rgb(from var(--border) r g b / <alpha-value>)',
        'border-strong': 'rgb(from var(--border-strong) r g b / <alpha-value>)',
        text: 'rgb(from var(--text) r g b / <alpha-value>)',
        muted: 'rgb(from var(--muted) r g b / <alpha-value>)',
        accent: 'rgb(from var(--accent) r g b / <alpha-value>)',
        'accent-hover': 'rgb(from var(--accent-hover) r g b / <alpha-value>)',
        'on-accent': 'rgb(from var(--on-accent) r g b / <alpha-value>)',
        green: 'rgb(from var(--green) r g b / <alpha-value>)',
        amber: 'rgb(from var(--amber) r g b / <alpha-value>)',
        red: 'rgb(from var(--red) r g b / <alpha-value>)',
      },
      borderRadius: {
        panel: '18px',
        control: '14px',
        pill: '9999px',
      },
      fontSize: {
        display: ['24px', { lineHeight: '32px', fontWeight: '600' }],
        title: ['16px', { lineHeight: '24px', fontWeight: '600' }],
        body: ['14px', { lineHeight: '22px' }],
        label: ['12px', { lineHeight: '16px', fontWeight: '500' }],
        caption: ['11px', { lineHeight: '14px' }],
        micro: ['10px', { lineHeight: '12px' }],
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
} satisfies Config
