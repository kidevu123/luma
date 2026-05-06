// Tiny dependency-free charts. Inline SVG, no chart library — keeps
// the bundle small and matches the rest of the codebase's "build
// from primitives" style. Three primitives:
//   - <BarRow />      one horizontal bar with label + value (for tables)
//   - <SparkBars />   compact bar series for "last N days" trends
//   - <Histogram />   binned distribution
//   - <DonutChart />  pie/donut for share-of-total breakdowns

import * as React from "react";

const PALETTE = [
  "#2563eb", // brand blue
  "#10b981", // emerald
  "#f59e0b", // amber
  "#ef4444", // red
  "#8b5cf6", // purple
  "#06b6d4", // cyan
  "#ec4899", // pink
  "#64748b", // slate
];

export function BarRow({
  value,
  max,
  color = "#2563eb",
  className,
}: {
  value: number;
  max: number;
  color?: string;
  className?: string;
}) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div
      className={`h-1.5 bg-surface-2 rounded-full overflow-hidden ${className ?? ""}`}
    >
      <div
        className="h-full rounded-full"
        style={{ width: `${pct}%`, background: color }}
      />
    </div>
  );
}

export function SparkBars({
  data,
  height = 48,
  color = "#10b981",
}: {
  data: number[];
  height?: number;
  color?: string;
}) {
  const max = Math.max(1, ...data);
  const w = 4;
  const gap = 2;
  const totalW = data.length * (w + gap) - gap;
  return (
    <svg
      width={totalW}
      height={height}
      viewBox={`0 0 ${totalW} ${height}`}
      className="block"
    >
      {data.map((v, i) => {
        const h = max > 0 ? (v / max) * height : 0;
        return (
          <rect
            key={i}
            x={i * (w + gap)}
            y={height - h}
            width={w}
            height={h}
            fill={color}
            rx={1}
          />
        );
      })}
    </svg>
  );
}

export function Histogram({
  values,
  bins = 10,
  unit = "",
  height = 100,
  color = "#2563eb",
}: {
  values: number[];
  bins?: number;
  unit?: string;
  height?: number;
  color?: string;
}) {
  if (values.length === 0) {
    return (
      <p className="text-xs text-text-muted py-3 text-center">No data yet.</p>
    );
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(1, max - min);
  const binSize = range / bins;
  const counts = new Array(bins).fill(0);
  const bounds: number[] = [];
  for (let i = 0; i <= bins; i++) bounds.push(min + i * binSize);
  for (const v of values) {
    const idx = Math.min(bins - 1, Math.floor((v - min) / binSize));
    counts[idx] += 1;
  }
  const maxCount = Math.max(1, ...counts);
  const w = 22;
  const gap = 4;
  const totalW = bins * (w + gap) - gap + 8;

  return (
    <div className="space-y-1">
      <svg
        width={totalW}
        height={height + 16}
        viewBox={`0 0 ${totalW} ${height + 16}`}
        className="block"
      >
        {counts.map((c, i) => {
          const h = (c / maxCount) * height;
          return (
            <g key={i}>
              <rect
                x={4 + i * (w + gap)}
                y={height - h}
                width={w}
                height={h}
                fill={color}
                rx={2}
              />
              <text
                x={4 + i * (w + gap) + w / 2}
                y={height - h - 2}
                fontSize={9}
                fill="#94a3b8"
                textAnchor="middle"
              >
                {c > 0 ? c : ""}
              </text>
            </g>
          );
        })}
        <line
          x1={4}
          y1={height}
          x2={totalW - 4}
          y2={height}
          stroke="#cbd5e1"
          strokeWidth={0.5}
        />
      </svg>
      <div className="flex justify-between text-[10px] text-text-subtle font-mono">
        <span>
          {Math.round(min)}
          {unit}
        </span>
        <span>
          {Math.round(max)}
          {unit}
        </span>
      </div>
    </div>
  );
}

export function DonutChart({
  segments,
  size = 140,
  thickness = 24,
}: {
  segments: { label: string; value: number; color?: string }[];
  size?: number;
  thickness?: number;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (total <= 0) {
    return (
      <p className="text-xs text-text-muted py-3 text-center">No data yet.</p>
    );
  }
  const radius = size / 2 - thickness / 2;
  const center = size / 2;
  const circumference = 2 * Math.PI * radius;
  let cumulative = 0;
  return (
    <div className="flex items-center gap-4">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {segments.map((s, i) => {
          const dash = (s.value / total) * circumference;
          const offset = -cumulative;
          cumulative += dash;
          const color = s.color ?? PALETTE[i % PALETTE.length] ?? "#64748b";
          return (
            <circle
              key={i}
              cx={center}
              cy={center}
              r={radius}
              fill="transparent"
              stroke={color}
              strokeWidth={thickness}
              strokeDasharray={`${dash} ${circumference - dash}`}
              strokeDashoffset={offset}
              transform={`rotate(-90 ${center} ${center})`}
            />
          );
        })}
        <text
          x={center}
          y={center - 4}
          fontSize={20}
          fill="#0f172a"
          textAnchor="middle"
          fontWeight="700"
        >
          {total.toLocaleString()}
        </text>
        <text
          x={center}
          y={center + 14}
          fontSize={10}
          fill="#64748b"
          textAnchor="middle"
        >
          total
        </text>
      </svg>
      <ul className="space-y-1.5 text-xs flex-1 min-w-0">
        {segments.map((s, i) => {
          const color = s.color ?? PALETTE[i % PALETTE.length] ?? "#64748b";
          const pct = total > 0 ? (s.value / total) * 100 : 0;
          return (
            <li
              key={i}
              className="flex items-center gap-2 min-w-0"
            >
              <span
                className="h-2 w-2 rounded-full shrink-0"
                style={{ background: color }}
              />
              <span className="truncate flex-1 text-text-muted">{s.label}</span>
              <span className="font-medium tabular-nums">
                {s.value.toLocaleString()}
              </span>
              <span className="text-text-subtle tabular-nums w-10 text-right">
                {pct.toFixed(0)}%
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
