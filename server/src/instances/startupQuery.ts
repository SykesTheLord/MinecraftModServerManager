/**
 * Spots a server that has stopped partway through starting to ask a question
 * on its console — Forge (1.12 and older) does this when the world contains
 * blocks/items whose mod or entry no longer exists ("missing registry
 * entries", typically after a pack update), and waits for `/fml confirm`
 * (delete them from the world and carry on) or `/fml cancel` (abort startup).
 * Until it's answered the server never finishes starting, and players are told
 * "Server is still starting!".
 */
export interface StartupQuery {
  /** Registry names Forge listed as missing, e.g. "thaumictinkerer:cleaning_talisman". */
  entries: string[];
  /** The log lines Forge printed about it, for the details. */
  excerpt: string;
}

const PROMPT = /\/fml confirm/i;
const BLOCK_START = /missing registry|detected missing|unassigned|unidentified|missing (blocks|items|entries|mappings)|mismatched/i;
/** modid:name, with a letter on both sides (so timestamps like 19:50 don't count). */
const REGISTRY_NAME = /\b([a-z0-9_.-]*[a-z][a-z0-9_.-]*):([a-z0-9_./-]*[a-z][a-z0-9_./-]*)\b/g;
const LOOKBACK = 200;
const MAX_EXCERPT_LINES = 60;

/** Finds the question in a boot's log output (oldest line first), or null if the server isn't asking one. */
export function findStartupQuery(log: string): StartupQuery | null {
  const lines = log.split("\n");
  let prompt = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (PROMPT.test(lines[i])) {
      prompt = i;
      break;
    }
  }
  if (prompt === -1) return null;

  // Forge's block about it starts at its first "missing …" line before the prompt.
  let start = Math.max(0, prompt - 15);
  for (let i = Math.max(0, prompt - LOOKBACK); i < prompt; i++) {
    if (BLOCK_START.test(lines[i])) {
      start = i;
      break;
    }
  }
  const block = lines.slice(start, prompt + 1).filter((line) => !/ModTracker/.test(line));
  const entries = new Set<string>();
  for (const line of block) {
    // Only the message part: "[time] [thread/LEVEL] [FML]: message".
    const message = line.replace(/^.*?\[[^\]]*\/[A-Z]+\](?: \[[^\]]*\])?:\s*/, "");
    if (PROMPT.test(message) || /-Dfml\./.test(message)) continue;
    for (const match of message.matchAll(REGISTRY_NAME)) entries.add(match[0]);
  }
  return { entries: [...entries].slice(0, 100), excerpt: block.slice(-MAX_EXCERPT_LINES).join("\n") };
}
