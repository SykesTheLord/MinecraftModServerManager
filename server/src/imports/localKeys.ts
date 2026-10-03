import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ssh2, { type ParsedKey } from "ssh2";
import { env } from "../config/env.js";
import { HttpError } from "../http/errors.js";

/**
 * SSH keys of the user who runs the manager, for authenticating SSH imports
 * without pasting a key or password. scripts/apply.sh mounts that user's
 * ~/.ssh (or SSH_KEYS_DIR from .env) read-only at SSH_KEYS_PATH. Only names,
 * types, fingerprints and public halves ever leave this module for the UI;
 * private keys are read here and handed straight to the SSH client.
 */

export interface LocalKeyInfo {
  /** File name in the keys directory — what the import form sends back. */
  name: string;
  /** e.g. "ssh-ed25519"; null if it can't be told without the passphrase (and there's no .pub file). */
  type: string | null;
  /** SHA256:… as `ssh-keygen -lf` prints it; null as for `type`. */
  fingerprint: string | null;
  /** The public key line to put in the remote's authorized_keys; null as for `type`. */
  publicKey: string | null;
  comment: string;
  /** Needs a passphrase to use. */
  encrypted: boolean;
}

// ssh2 is CommonJS: Node can't see `utils` as a named ESM export, so take it off the default export.
const { utils } = ssh2;

const MAX_KEY_BYTES = 64 * 1024;
/** Files in ~/.ssh that are never private keys. */
const NOT_KEYS = /^(known_hosts|authorized_keys|config|environment)(\..*)?$|\.pub$/;

function firstKey(parsed: ParsedKey | ParsedKey[] | Error): ParsedKey | Error {
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

function describe(key: ParsedKey): Pick<LocalKeyInfo, "type" | "fingerprint" | "publicKey" | "comment"> {
  const blob = key.getPublicSSH();
  return {
    type: key.type,
    fingerprint: `SHA256:${crypto.createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`,
    publicKey: `${key.type} ${blob.toString("base64")}${key.comment ? ` ${key.comment}` : ""}`,
    comment: key.comment,
  };
}

function readSmallFile(file: string): string | null {
  try {
    const stat = fs.statSync(file); // follows symlinks; ones pointing outside the mount just fail here
    if (!stat.isFile() || stat.size > MAX_KEY_BYTES) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function listLocalKeys(): LocalKeyInfo[] {
  let names: string[];
  try {
    names = fs.readdirSync(env.SSH_KEYS_PATH);
  } catch {
    return []; // not mounted
  }
  const keys: LocalKeyInfo[] = [];
  for (const name of names.sort()) {
    if (name.startsWith(".") || NOT_KEYS.test(name)) continue;
    const text = readSmallFile(path.join(env.SSH_KEYS_PATH, name));
    if (!text || !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) continue;
    const parsed = firstKey(utils.parseKey(text));
    if (!(parsed instanceof Error)) {
      keys.push({ name, encrypted: false, ...describe(parsed) });
      continue;
    }
    if (!/passphrase/i.test(parsed.message)) continue; // not a key ssh2 can use at all
    // Encrypted: describe it from its .pub file, if there is one.
    const pubText = readSmallFile(path.join(env.SSH_KEYS_PATH, `${name}.pub`));
    const pub = pubText ? firstKey(utils.parseKey(pubText)) : null;
    keys.push(
      pub && !(pub instanceof Error)
        ? { name, encrypted: true, ...describe(pub) }
        : { name, encrypted: true, type: null, fingerprint: null, publicKey: null, comment: "" }
    );
  }
  return keys;
}

/**
 * The private key text for one of the listed keys, checked to be usable with
 * the given passphrase — so a wrong passphrase is reported straight away
 * instead of failing the import in the background.
 */
export function readLocalKey(name: string, passphrase: string | undefined): string {
  // Only names the listing offers: never a path the client made up.
  if (!listLocalKeys().some((k) => k.name === name)) throw new HttpError(400, `There's no SSH key named "${name}" on this host.`);
  const text = readSmallFile(path.join(env.SSH_KEYS_PATH, name));
  if (!text) throw new HttpError(400, `Couldn't read the SSH key "${name}".`);
  assertUsableKey(text, passphrase);
  return text;
}

/** Throws a 400 if ssh2 can't use this private key with this passphrase. */
export function assertUsableKey(text: string, passphrase: string | undefined): void {
  const parsed = firstKey(utils.parseKey(text, passphrase || undefined));
  if (!(parsed instanceof Error)) return;
  if (/no passphrase given/i.test(parsed.message)) throw new HttpError(400, "That SSH key is protected by a passphrase — enter it.");
  if (/bad passphrase|decrypt/i.test(parsed.message)) throw new HttpError(400, "Wrong passphrase for that SSH key.");
  throw new HttpError(400, `Couldn't use that private key: ${parsed.message}`);
}
