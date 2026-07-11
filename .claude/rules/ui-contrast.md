# Contraste e Cor de Texto na UI (tema escuro)

O dashboard do Cerberus é um painel tático **dark mode**. Texto de baixo contraste
(escuro sobre escuro) é um bug de acessibilidade recorrente que precisa ser evitado
por construção. **Ler antes de** criar/estilizar botões, badges, chips, inputs ou
qualquer elemento interativo com texto.

## A causa nº 1 (e a defesa)

Elementos `<button>` **não herdam** a cor do texto por padrão — o navegador aplica a
cor de sistema `buttontext` (escura), que some no fundo escuro. A regra global em
[globals.css](../../apps/dashboard/src/app/globals.css) resolve isso na raiz:

```css
button {
  color: inherit; /* herda --text (claro); sem isto o texto fica escuro/invisível */
}
```

**Não remova** esse `color: inherit`. Se um botão precisa de outra cor, defina-a
**explicitamente** (ex.: `color: '#fff'` num botão de ação colorido) — nunca dependa
do padrão do navegador.

## Regras obrigatórias

1. **Todo texto interativo tem cor explícita ou herda `--text`.** Ao reusar a classe
   `.badge` (ou qualquer classe sem `color`) num `<button>`, confie no `color: inherit`
   global — não sobrescreva para `var(--muted)` a menos que o elemento seja realmente
   secundário E ainda passe no contraste.
2. **`--muted` (`#8b9aa8`) é só para texto secundário/decorativo** sobre `--panel`/
   `--bg`. Nunca use `--muted` como cor principal de um controle clicável (rótulo de
   botão, item de menu). Contra `--panel` (`#141b24`) o `--muted` fica no limite do
   contraste — reserve-o para legendas, não para ações.
3. **Botões "fantasma" (fundo transparente) precisam de cor de texto legível.** Em
   modais e barras sobre o mapa, `background: transparent` + sem `color` = texto do
   UA (escuro). Garanta `color: var(--text)` (há o helper `ghostBtn` no
   `SettingsModal`).
4. **Alvo de contraste: WCAG AA (≥ 4.5:1 para texto normal, ≥ 3:1 para texto grande/
   ícones).** Na dúvida, use `--text` sobre `--panel`/`--bg`.
5. **Controles nativos (spinner de `input[type=number]`, date pickers) em fundo escuro
   recebem `color-scheme: dark`** para o navegador desenhar as setas/ícones claros
   sobre fundo escuro (senão aparece o quadradinho branco padrão).

## Paleta de referência (variáveis em `:root`)

| Token | Hex | Uso |
| --- | --- | --- |
| `--text` | `#e6edf3` | Texto principal, rótulos de botões/controles |
| `--muted` | `#8b9aa8` | **Apenas** texto secundário/legendas |
| `--bg` / `--panel` / `--panel-2` | `#0b0f14` / `#141b24` / `#1c2733` | Fundos |
| `--accent` | `#c1121f` | Ação primária/institucional (texto branco por cima) |
| `--ok` | `#3fb950` | Estado positivo (ex.: barramento conectado) |

## Relação com outras regras

- [pt-br-content.md](pt-br-content.md) — o texto exibido ao operador é pt-BR acentuado;
  esta regra cuida de que ele seja **legível**.
