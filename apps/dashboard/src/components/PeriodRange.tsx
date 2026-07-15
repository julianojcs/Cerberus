'use client';

/**
 * Barra de período com DOIS controles (início e fim). Usa dois <input type=range>
 * sobrepostos (técnica padrão de "dual range"): a trilha e o preenchimento são
 * <div>s; cada thumb ajusta uma ponta, sempre mantendo início ≤ fim.
 * Valores em ms (epoch). O CSS `.rangepair` está em globals.css.
 *
 * Com `format`, cada thumb ganha uma "pílula" com a data/hora daquela ponta (como a
 * barra do replay) — posicionada acima do thumb correspondente.
 */
export function PeriodRange({
  min,
  max,
  start,
  end,
  step = 60_000,
  format,
  onChange,
}: {
  min: number;
  max: number;
  start: number;
  end: number;
  step?: number;
  format?: (ms: number) => string;
  onChange: (start: number, end: number) => void;
}) {
  const span = Math.max(1, max - min);
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const startPct = ((lo - min) / span) * 100;
  const endPct = ((hi - min) / span) * 100;

  const pill = (pct: number, ms: number): React.CSSProperties => ({
    position: 'absolute',
    top: 0,
    left: `${pct}%`,
    transform: 'translateX(-50%)',
    whiteSpace: 'nowrap',
    fontSize: 11,
    fontVariantNumeric: 'tabular-nums',
    color: 'var(--text)',
    background: '#141b24',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '1px 5px',
    pointerEvents: 'none',
    ...(ms > 0 ? null : { display: 'none' }),
  });

  return (
    <div style={{ flex: 1, minWidth: 160, position: 'relative', paddingTop: format ? 22 : 0 }}>
      {/* Pílulas de data/hora sobre cada thumb (como no replay). */}
      {format && (
        <>
          <div style={pill(startPct, lo)}>{format(lo)}</div>
          <div style={pill(endPct, hi)}>{format(hi)}</div>
        </>
      )}
      <div className="rangepair" style={{ width: '100%' }}>
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
    </div>
  );
}
