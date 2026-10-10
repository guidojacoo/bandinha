/**
 * Loads .env for CLI entry points.
 *
 * Next.js does this itself for the web app; the CLIs run under plain Node, so
 * they import this first. Uses Node 22's built-in loader — no dependency.
 */
import { existsSync } from "node:fs";

export function loadEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  try {
    process.loadEnvFile(path);
  } catch {
    // Already loaded, or unreadable — not worth failing a CLI over.
  }
}

loadEnv();
