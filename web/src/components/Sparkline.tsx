interface Props {
  values: number[]
  width?: number
  height?: number
  stroke?: string
}

export default function Sparkline({ values, width = 96, height = 24, stroke = 'var(--accent)' }: Props) {
  if (values.length < 2) return <svg width={width} height={height} />
  const max = Math.max(...values, 1)
  const pts = values
    .map((v, i) => `${(i / (values.length - 1)) * width},${height - 2 - (v / max) * (height - 4)}`)
    .join(' ')
  return (
    <svg width={width} height={height} className="overflow-visible">
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" opacity="0.9" />
      <polyline points={`0,${height} ${pts} ${width},${height}`} fill={stroke} opacity="0.07" stroke="none" />
    </svg>
  )
}
