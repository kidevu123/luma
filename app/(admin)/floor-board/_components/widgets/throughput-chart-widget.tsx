// app/(admin)/floor-board/_components/widgets/throughput-chart-widget.tsx
"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ThroughputDataPoint } from "@/lib/floor-command/types";

export function ThroughputChartWidget({
  data,
  targetBagsPerHour,
}: {
  data: ThroughputDataPoint[];
  targetBagsPerHour: number | null;
}) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-slate-600 text-sm">
        No throughput data yet
      </div>
    );
  }

  return (
    <div className="h-full w-full p-1">
      <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: -20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis
              dataKey="label"
              tick={{ fill: "#64748b", fontSize: 10 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tick={{ fill: "#64748b", fontSize: 10 }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              contentStyle={{
                background: "#0f1a2b",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 4,
              }}
              labelStyle={{ color: "#94a3b8", fontSize: 11 }}
              itemStyle={{ color: "#2ee8a5", fontSize: 11 }}
            />
            {targetBagsPerHour !== null && (
              <ReferenceLine
                y={targetBagsPerHour}
                stroke="#f5b544"
                strokeDasharray="4 4"
                label={{
                  value: `target ${targetBagsPerHour}`,
                  fill: "#f5b544",
                  fontSize: 10,
                }}
              />
            )}
            <Line
              type="monotone"
              dataKey="bagsPerHour"
              stroke="#2ee8a5"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, fill: "#2ee8a5" }}
            />
          </LineChart>
        </ResponsiveContainer>
    </div>
  );
}
