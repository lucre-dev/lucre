/** Minimal Grok-ish palette — sparse, high contrast, no chrome bloat. */
export const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  italic: "\x1b[3m",
  // greys
  fg: "\x1b[38;5;252m",
  muted: "\x1b[38;5;245m",
  faint: "\x1b[38;5;240m",
  // accents
  green: "\x1b[38;5;114m",
  red: "\x1b[38;5;167m",
  yellow: "\x1b[38;5;179m",
  blue: "\x1b[38;5;110m",
  cyan: "\x1b[38;5;116m",
  magenta: "\x1b[38;5;176m",
  orange: "\x1b[38;5;208m",
};

export function paint(color: string, s: string): string {
  return `${color}${s}${c.reset}`;
}

export function dim(s: string): string {
  return paint(c.dim + c.muted, s);
}

export function bold(s: string): string {
  return paint(c.bold + c.fg, s);
}
