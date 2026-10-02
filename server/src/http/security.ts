import net from "node:net";
import type { IncomingHttpHeaders } from "node:http";
import type { RequestHandler } from "express";
import { docker } from "../docker/dockerClient.js";
import { env, trustProxy } from "../config/env.js";
import { appLogger } from "../logging/appLogger.js";
import { ARTWORK_HOSTS } from "./artwork.js";

/**
 * Baseline browser hardening for everything the manager serves. The built SPA
 * is one same-origin module script + one stylesheet (no inline script/style),
 * so a strict same-origin CSP fits. `connect-src 'self'` also covers the
 * same-host ws:/wss: console socket in current browsers. frame-ancestors /
 * X-Frame-Options stop the UI being framed for clickjacking. No HSTS: the
 * manager itself speaks plain HTTP; set it at your TLS terminator.
 */
const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    // Modpack artwork, straight from FTB's and CurseForge's CDNs (images can't run code).
    `img-src 'self' data: ${ARTWORK_HOSTS.join(" ")}`,
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
};

export const securityHeaders: RequestHandler = (_req, res, next) => {
  res.set(SECURITY_HEADERS);
  next();
};

/** The host the browser addressed, honoring X-Forwarded-Host only when a proxy is explicitly trusted. */
function requestHost(headers: IncomingHttpHeaders): string | undefined {
  const forwarded = trustProxy ? headers["x-forwarded-host"] : undefined;
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (value?.split(",")[0]?.trim() || headers.host)?.toLowerCase();
}

/**
 * True if a browser sent this request on behalf of a different origin. The
 * session cookie is SameSite=Lax, which blocks fully cross-site requests but
 * not ones from sibling subdomains (same "site"), and doesn't apply to
 * non-cookie concerns at all — so check the origin explicitly. Browsers always
 * send Origin on WebSocket handshakes and on non-GET fetches; requests with
 * neither Origin nor Sec-Fetch-Site come from non-browser clients, which can't
 * ride a victim's cookies and are let through.
 */
export function isCrossOriginBrowserRequest(headers: IncomingHttpHeaders): boolean {
  const origin = headers.origin;
  if (origin) {
    try {
      return new URL(origin).host.toLowerCase() !== requestHost(headers);
    } catch {
      return true; // e.g. "null" from sandboxed frames / file: pages
    }
  }
  const fetchSite = headers["sec-fetch-site"];
  if (fetchSite) return fetchSite !== "same-origin" && fetchSite !== "none";
  return false;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** CSRF defense for the API: state-changing requests must come from the manager's own origin. */
export const requireSameOriginForWrites: RequestHandler = (req, res, next) => {
  if (!SAFE_METHODS.has(req.method) && isCrossOriginBrowserRequest(req.headers)) {
    res.status(403).json({ error: "Cross-origin request rejected." });
    return;
  }
  next();
};

/*
 * Modpack containers run hundreds of third-party mods and share mc-net with
 * the manager (it needs that network to reach their RCON ports), so by
 * default any of them could call the manager's API directly. Nothing
 * legitimate on mc-net talks to the manager over HTTP, so connections from
 * mc-net addresses are refused — except the network's gateway, which is how
 * the host itself (and Docker's port publishing, for localhost clients)
 * appears. Uses the socket's peer address, never X-Forwarded-For.
 *
 * This only closes the *direct* path. A container can still reach whatever
 * address the manager's port is published on; with the default
 * MANAGER_BIND=127.0.0.1 that's nothing a container can reach, but with the
 * port published on a LAN interface, modpacks can reach the manager exactly
 * as well as any LAN host can (Docker makes that hairpinned traffic appear
 * to come from the gateway).
 */
let instanceNetworkBlocklist: net.BlockList | null = null;
const allowedGateways = new Set<string>();

function normalizeAddress(address: string): string {
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

export async function loadInstanceNetworkBlocklist(): Promise<void> {
  const info = await docker.getNetwork(env.DOCKER_NETWORK).inspect();
  const blocklist = new net.BlockList();
  for (const config of (info.IPAM?.Config ?? []) as { Subnet?: string; Gateway?: string }[]) {
    if (!config.Subnet) continue;
    const [address, prefix] = config.Subnet.split("/");
    const family = net.isIPv6(address) ? "ipv6" : "ipv4";
    blocklist.addSubnet(address, Number(prefix), family);
    if (config.Gateway) allowedGateways.add(config.Gateway);
  }
  instanceNetworkBlocklist = blocklist;
  appLogger.info({ network: env.DOCKER_NETWORK, gateways: [...allowedGateways] }, "blocking manager access from instance network");
}

export function isFromInstanceNetwork(remoteAddress: string | undefined): boolean {
  if (!remoteAddress || !instanceNetworkBlocklist) return false;
  const address = normalizeAddress(remoteAddress);
  if (allowedGateways.has(address)) return false;
  return instanceNetworkBlocklist.check(address, net.isIPv6(address) ? "ipv6" : "ipv4");
}

export const rejectInstanceNetwork: RequestHandler = (req, res, next) => {
  if (isFromInstanceNetwork(req.socket.remoteAddress)) {
    res.status(403).json({ error: "Forbidden." });
    return;
  }
  next();
};
