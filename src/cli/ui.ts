/** Terminal output helpers. Colour is dropped when not attached to a TTY. */
const useColour = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const wrap = (code: string) => (s: string) => (useColour ? `\u001b[${code}m${s}\u001b[0m` : s);

export const c = {
  bold: wrap("1"),
  dim: wrap("2"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  cyan: wrap("36"),
};

export function heading(text: string): void {
  console.log(`\n${c.bold(text)}\n${c.dim("─".repeat(Math.min(72, text.length + 8)))}`);
}

export function kv(key: string, value: string | number): void {
  console.log(`  ${c.dim(key.padEnd(22))} ${value}`);
}

export function bullet(text: string): void {
  console.log(`  ${c.dim("•")} ${text}`);
}

export function ok(text: string): void {
  console.log(`  ${c.green("✓")} ${text}`);
}

export function warn(text: string): void {
  console.log(`  ${c.yellow("!")} ${text}`);
}

export function fail(text: string): void {
  console.log(`  ${c.red("✗")} ${text}`);
}

export function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split("=", 2);
    if (!name) continue;
    if (inline !== undefined) flags[name] = inline;
    else if (argv[i + 1] && !argv[i + 1]!.startsWith("--")) flags[name] = argv[++i]!;
    else flags[name] = true;
  }
  return { positional, flags };
}
