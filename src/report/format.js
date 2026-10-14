const useColor = () => process.stdout.isTTY && !process.env.NO_COLOR && !process.argv.includes('--no-color');

const code = (open, close) => (s) => (useColor() ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
export const c = {
  bold: code(1, 22),
  dim: code(2, 22),
  red: code(31, 39),
  green: code(32, 39),
  yellow: code(33, 39),
  blue: code(34, 39),
  magenta: code(35, 39),
  cyan: code(36, 39),
  gray: code(90, 39),
};

export const CATEGORY_COLOR = {
  overhead: c.gray,
  conversation: c.green,
  thinking: c.blue,
  code_read: c.cyan,
  code_write: c.cyan,
  build: c.yellow,
  env: c.red,
  git: c.magenta,
  web: c.blue,
  browser: c.blue,
  agents: c.magenta,
  other: c.gray,
};

export function tok(n) {
  n = Math.round(n || 0);
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k';
  return String(n);
}

export const int = (n) => Math.round(n || 0).toLocaleString('en-US');
export const pct = (x, d = 0) => `${((x || 0) * 100).toFixed(d)}%`;

export function bar(fraction, width, color = (s) => s) {
  const cells = Math.max(0, Math.min(width, fraction * width));
  const full = Math.floor(cells);
  const partial = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'][Math.round((cells - full) * 7)];
  const filled = '█'.repeat(full) + partial;
  return color(filled) + c.dim('·'.repeat(Math.max(0, width - [...filled].length)));
}

export function date(iso) {
  if (!iso) return '?';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function pad(s, n, right = false) {
  const len = String(s).replace(/\x1b\[[0-9;]*m/g, '').length;
  const fill = ' '.repeat(Math.max(0, n - len));
  return right ? fill + s : s + fill;
}
