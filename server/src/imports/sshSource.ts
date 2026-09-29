import crypto from "node:crypto";
import { PassThrough } from "node:stream";
import { Client, type ConnectConfig } from "ssh2";
import { HttpError } from "../http/errors.js";
import { extractTarStream } from "./archive.js";

export interface SshTarget {
  host: string;
  port: number;
}

export interface SshPullOptions extends SshTarget {
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  /** Absolute path of the server directory on the remote machine. */
  remotePath: string;
  /** Run tar through `sudo -n`, for servers owned by a dedicated service user. */
  useSudo: boolean;
  /** Top-level directories not worth transferring (logs, backups, …). */
  exclude: string[];
  /** The host key fingerprint the admin confirmed (SHA256:… as printed by ssh-keygen -lf). */
  hostFingerprint: string;
}

export interface HostKeyInfo {
  fingerprint: string;
  keyType: string;
}

const CONNECT_TIMEOUT_MS = 15_000;

/** OpenSSH's SHA256 fingerprint format for a wire-format public key blob. */
function fingerprintOf(key: Buffer): string {
  return `SHA256:${crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

/** The algorithm name at the start of a wire-format public key blob, e.g. "ssh-ed25519". */
function keyTypeOf(key: Buffer): string {
  const length = key.readUInt32BE(0);
  return key.subarray(4, 4 + length).toString("ascii");
}

/** POSIX single-quoting for the remote shell. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function describeError(err: Error & { level?: string }): string {
  if (err.level === "client-authentication") return "SSH authentication failed — check the username and password/key.";
  if (err.level === "client-timeout") return "Timed out connecting over SSH.";
  if (/verification failed/i.test(err.message)) {
    return "The server's host key doesn't match the confirmed fingerprint — the key changed, or the connection is being intercepted. Check the host key again.";
  }
  return `SSH connection failed: ${err.message}`;
}

/**
 * Fetches the host key a server presents, without authenticating, so the
 * admin can compare it against the real one (`ssh-keygen -lf` on the source
 * machine) before any credentials are sent. The pull itself then refuses any
 * other key: without that pinning, anyone who can intercept the connection
 * could collect the credentials and feed back arbitrary "server files".
 */
export function fetchHostKey(target: SshTarget): Promise<HostKeyInfo> {
  return new Promise((resolve, reject) => {
    let seen: HostKeyInfo | null = null;
    const conn = new Client();
    const finish = () => {
      conn.end();
      if (seen) resolve(seen);
      else reject(new HttpError(502, `Couldn't reach an SSH server at ${target.host}:${target.port}.`));
    };
    conn.on("error", (err) => {
      if (seen) finish();
      else reject(new HttpError(502, describeError(err)));
    });
    conn.on("ready", finish);
    conn.connect({
      host: target.host,
      port: target.port,
      username: "host-key-probe",
      readyTimeout: CONNECT_TIMEOUT_MS,
      hostVerifier: (key: Buffer) => {
        seen = { fingerprint: fingerprintOf(key), keyType: keyTypeOf(key) };
        return false; // abort before authenticating
      },
    });
  });
}

/**
 * Streams the remote server directory over SSH as `tar -cz` (one stream is
 * far faster than per-file SFTP for a modpack's thousands of small files, and
 * tar/gzip exist on any Ubuntu install) straight into `dest`. `onProgress`
 * gets the compressed bytes received so far.
 *
 * Resolves with a warning when tar reports files changed while being read
 * (exit status 1) — the archive is still complete, but that almost always
 * means the server was still running and its world may be inconsistent.
 */
export function pullOverSsh(
  options: SshPullOptions,
  dest: string,
  maxBytes: number,
  onProgress: (bytes: number) => void,
  signal: AbortSignal
): Promise<{ warning: string | null }> {
  if (!options.remotePath.startsWith("/")) {
    return Promise.reject(new HttpError(400, "The remote path must be absolute (e.g. /opt/minecraft/server)."));
  }
  const excludes = options.exclude.map((dir) => `--exclude=${shellQuote(`./${dir}`)}`).join(" ");
  const command = `${options.useSudo ? "sudo -n " : ""}tar -C ${shellQuote(options.remotePath)} ${excludes} -czf - .`;

  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      conn.end();
      reject(err);
    };
    signal.addEventListener("abort", () => fail(new HttpError(409, "Import cancelled.")), { once: true });

    conn.on("error", (err) => fail(new HttpError(502, describeError(err))));
    conn.on("close", () => fail(new HttpError(502, "The SSH connection closed unexpectedly.")));
    conn.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
      // Servers with PasswordAuthentication off often still take the password this way.
      finish(prompts.map(() => options.password ?? ""));
    });
    conn.on("ready", () => {
      conn.exec(command, (execErr, stream) => {
        if (execErr) return fail(new HttpError(502, `Couldn't run tar on the remote machine: ${execErr.message}`));

        let stderr = "";
        stream.stderr.on("data", (chunk: Buffer) => {
          if (stderr.length < 4000) stderr += chunk.toString("utf8");
        });

        let received = 0;
        const counter = new PassThrough();
        counter.on("data", (chunk: Buffer) => {
          received += chunk.length;
          onProgress(received);
        });

        let exitCode: number | null = null;
        stream.on("exit", (code: number | null) => {
          exitCode = code;
        });
        const exited = new Promise<void>((done) => stream.on("close", () => done()));
        stream.pipe(counter);
        const extracted = extractTarStream(counter, dest, true, maxBytes);

        Promise.allSettled([extracted, exited]).then(([extraction]) => {
          if (settled) return;
          const detail = stderr.trim().split("\n").slice(-5).join("\n");
          if (exitCode !== 0 && exitCode !== 1) {
            const hint = /sudo/.test(detail) ? " (sudo needs to be passwordless for this user)" : "";
            return fail(new HttpError(502, `Remote tar failed (exit ${exitCode})${hint}: ${detail || "no output"}`));
          }
          if (extraction.status === "rejected") return fail(extraction.reason);
          settled = true;
          conn.end();
          resolve({
            warning:
              exitCode === 1
                ? "Some files changed while they were being copied — was the server still running? Stop it and import again if the world looks inconsistent."
                : null,
          });
        });
      });
    });

    const config: ConnectConfig = {
      host: options.host,
      port: options.port,
      username: options.username,
      readyTimeout: CONNECT_TIMEOUT_MS,
      keepaliveInterval: 15_000,
      tryKeyboard: Boolean(options.password),
      hostVerifier: (key: Buffer) => fingerprintOf(key) === options.hostFingerprint,
    };
    if (options.privateKey) {
      config.privateKey = options.privateKey;
      if (options.passphrase) config.passphrase = options.passphrase;
    }
    if (options.password) config.password = options.password;
    try {
      conn.connect(config);
    } catch (err) {
      // ssh2 parses the private key synchronously, before connecting.
      fail(new HttpError(400, `Couldn't use that private key (wrong passphrase?): ${(err as Error).message}`));
    }
  });
}
