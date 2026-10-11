import { useMemo } from "react";

/** Banknote-style guilloche rosette: layered hypotrochoids, drawn once. */
function curve(R: number, r: number, d: number, turns: number, scale: number, steps = 1400) {
  const pts: string[] = [];
  const k = (R - r) / r;
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2 * turns;
    const x = (R - r) * Math.cos(t) + d * Math.cos(k * t);
    const y = (R - r) * Math.sin(t) - d * Math.sin(k * t);
    pts.push(`${(x * scale).toFixed(2)},${(y * scale).toFixed(2)}`);
  }
  return `M${pts.join("L")}Z`;
}

export function Rosette({ cracked }: { cracked: boolean }) {
  const layers = useMemo(
    () => [
      { d: curve(96, 36, 52, 3, 1.55), w: 0.6, o: 0.55 },
      { d: curve(80, 22, 40, 11, 1.62), w: 0.45, o: 0.5 },
      { d: curve(60, 14, 30, 7, 2.05), w: 0.5, o: 0.7 },
      { d: curve(105, 7.5, 12, 15, 1.3), w: 0.5, o: 0.8 },
    ],
    [],
  );

  return (
    <svg className={`rosette ${cracked ? "is-cracked" : ""}`} viewBox="-170 -170 340 340" aria-hidden="true">
      <g className="rosette-spin">
        {layers.map((l, i) => (
          <path key={i} d={l.d} fill="none" strokeWidth={l.w} opacity={l.o} />
        ))}
      </g>
      <circle r="112" fill="none" strokeWidth="1.2" />
      <circle r="118" fill="none" strokeWidth="0.4" />
    </svg>
  );
}
