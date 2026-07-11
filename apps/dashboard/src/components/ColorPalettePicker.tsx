'use client';

import { TAILWIND_FAMILIES } from '@/lib/tailwind-colors';

/**
 * Seletor de cor PRIMARIA por familia da paleta Tailwind (grade de swatches).
 * Porta o conceito do `ColorPalettePicker` do JMR26 para o Cerberus. O valor e o
 * TOKEN da familia (ex.: 'green'); o consumidor resolve o hex via `resolveColor`.
 */
export function ColorPalettePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (family: string) => void;
}) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {TAILWIND_FAMILIES.map((f) => (
        <button
          key={f.name}
          type="button"
          onClick={() => onChange(f.name)}
          title={f.name}
          aria-label={f.name}
          aria-pressed={value === f.name}
          style={{
            width: 20,
            height: 20,
            borderRadius: '50%',
            background: f.hex,
            border: '2px solid #fff',
            outline: value === f.name ? `2px solid ${f.hex}` : '2px solid transparent',
            outlineOffset: 1,
            cursor: 'pointer',
            padding: 0,
          }}
        />
      ))}
    </div>
  );
}
