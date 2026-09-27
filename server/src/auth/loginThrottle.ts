/**
 * In-memory brute-force throttle for /api/auth/login (single process, same
 * lifetime as the in-memory session store). Counts *failed* attempts in a
 * sliding window, keyed by client IP and by (IP, username):
 *
 * - per IP: caps how fast one client can guess at all;
 * - per IP+username: a tighter cap on hammering one account.
 *
 * Deliberately no global per-username lockout: that would let anyone lock the
 * real admin out just by failing logins as "admin" on purpose.
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_IP = 20;
const MAX_FAILURES_PER_IP_USER = 5;

const failures = new Map<string, number[]>();

function recent(key: string, now: number): number[] {
  const kept = (failures.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (kept.length) failures.set(key, kept);
  else failures.delete(key);
  return kept;
}

const ipKey = (ip: string) => `ip:${ip}`;
const userKey = (ip: string, username: string) => `user:${ip}:${username.toLowerCase()}`;

/** Seconds until another attempt is allowed, or 0 if not currently throttled. */
export function loginRetryAfterSeconds(ip: string, username: string, now = Date.now()): number {
  const checks: [number[], number][] = [
    [recent(ipKey(ip), now), MAX_FAILURES_PER_IP],
    [recent(userKey(ip, username), now), MAX_FAILURES_PER_IP_USER],
  ];
  let wait = 0;
  for (const [times, max] of checks) {
    if (times.length >= max) wait = Math.max(wait, times[times.length - max] + WINDOW_MS - now);
  }
  return Math.ceil(wait / 1000);
}

export function recordLoginFailure(ip: string, username: string, now = Date.now()): void {
  for (const key of [ipKey(ip), userKey(ip, username)]) {
    failures.set(key, [...recent(key, now), now]);
  }
}

export function recordLoginSuccess(ip: string, username: string): void {
  failures.delete(userKey(ip, username));
}

// Keep the map from growing without bound under a spray of distinct IPs/usernames.
setInterval(() => {
  const now = Date.now();
  for (const key of failures.keys()) recent(key, now);
}, WINDOW_MS).unref();
