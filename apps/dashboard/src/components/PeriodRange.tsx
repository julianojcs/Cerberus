'use client';

/**
 * Barra de período com DOIS controles (início e fim). Usa dois <input type=range>
 * sobrepostos (técnica padrão de "dual range"): a trilha e o preenchimento são
 * <div>s; cada thumb ajusta uma ponta, sempre mantendo início ≤ fim.
 * Valores em ms (epoch). O CSS `.rangepair` está em globals.css.
 */
export function PeriodRange({
  min,
  max,
  start,
  end,
  step = 60_000,
  onChange,
}: {
  min: number;
  max: number;
  start: number;
  end: number;
  step?: number;
  onChange: (start: number, end: number) => void;
}) {
  const span = Math.max(1, max - min);
  const startPct = ((Math.min(start, end) - min) / span) * 100;
  const endPct = ((Math.max(start, end) - min) / span) * 100;

  return (
    <div className="rangepair" style={{ flex: 1, minWidth: 120 }}>
      {/* Trilha de fundo */}
      <div
        style={{
          position: 'absolute',
          top: 9,
          left: 0,
          right: 0,
          height: 4,
          borderRadius: 2,
          background: 'var(--border)',
        }}
      />
      {/* Faixa selecionada (entre início e fim) */}
      <div
        style={{
          position: 'absolute',
          top: 9,
          height: 4,
          borderRadius: 2,
          background: '#c1121f',
          left: `${startPct}%`,
          width: `${Math.max(0, endPct - startPct)}%`,
        }}
      />
      {/* Início — nunca ultrapassa o fim */}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={start}
        aria-label="Início do período"
        onChange={(e) => onChange(Math.min(Number(e.target.value), end), end)}
      />
      {/* Fim — nunca fica antes do início */}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={end}
        aria-label="Fim do período"
        onChange={(e) => onChange(start, Math.max(Number(e.target.value), start))}
      />
    </div>
  );
}
