'use client';

/**
 * Chave toggle (switch) acessível, no estilo do painel tático. Usa role="switch"
 * + aria-checked para leitores de tela; o trilho fica vermelho quando ativo.
 */
export function Toggle({
  checked,
  onChange,
  label,
  title,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label?: string;
  title?: string;
}) {
  return (
    <label
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        cursor: 'pointer',
        userSelect: 'none',
      }}
    >
      {label && (
        <span style={{ fontSize: 13, color: checked ? 'var(--text, #e6edf3)' : 'var(--muted)' }}>
          {label}
        </span>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        style={{
          position: 'relative',
          width: 40,
          height: 22,
          flexShrink: 0,
          borderRadius: 11,
          border: '1px solid var(--border)',
          background: checked ? '#c1121f' : 'transparent',
          transition: 'background 0.15s ease',
          cursor: 'pointer',
          padding: 0,
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 2,
            left: checked ? 20 : 2,
            width: 16,
            height: 16,
            borderRadius: '50%',
            background: '#fff',
            transition: 'left 0.15s ease',
          }}
        />
      </button>
    </label>
  );
}
