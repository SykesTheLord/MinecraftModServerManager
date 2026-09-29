import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { env } from "../config/env.js";
import { HttpError } from "../http/errors.js";
import { appLogger } from "../logging/appLogger.js";
import { analyzeServer, DISPOSABLE_DIRS, findServerRoot, type ImportAnalysis } from "./analyze.js";
import { extractArchiveFile } from "./archive.js";
import { pullOverSsh, type SshPullOptions } from "./sshSource.js";

/**
 * Importing an existing server is staged: its files are first brought into
 * DATA_DIR/imports/<jobId>/files (uploaded as an archive, or pulled over SSH
 * from the machine it ran on), analyzed, and only then — after the admin has
 * reviewed what was detected — copied into a new instance's volume (see
 * instanceService.createImportedInstance). Jobs live in memory, like
 * sessions: a manager restart drops them and the staging area is wiped on
 * boot, so an interrupted import is simply started again.
 *
 *   receiving → processing → ready → deploying → (instance created; job removed)
 *        └───────────┴──────────┴─────→ failed
 */
export type ImportState = "receiving" | "processing" | "ready" | "deploying" | "failed";

interface ImportJob {
  id: string;
  source: "upload" | "ssh";
  /** File name, or user@host:/path — for display only. */
  label: string;
  state: ImportState;
  receivedBytes: number;
  /** Upload size declared up front; unknown for SSH (the tar is streamed). */
  expectedBytes: number | null;
  error: string | null;
  analysis: ImportAnalysis | null;
  /** The server's directory inside the staging area, once found. */
  root: string | null;
  writingChunk: boolean;
  abort: AbortController;
  updatedAt: number;
}

export type ImportJobView = Pick<
  ImportJob,
  "id" | "source" | "label" | "state" | "receivedBytes" | "expectedBytes" | "error" | "analysis"
>;

const IMPORTS_DIR = path.join(env.DATA_DIR, "imports");
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;

const jobs = new Map<string, ImportJob>();

const jobDir = (id: string) => path.join(IMPORTS_DIR, id);
const archivePath = (id: string) => path.join(jobDir(id), "upload.archive");
const filesDir = (id: string) => path.join(jobDir(id), "files");

function view(job: ImportJob): ImportJobView {
  const { id, source, label, state, receivedBytes, expectedBytes, error, analysis } = job;
  return { id, source, label, state, receivedBytes, expectedBytes, error, analysis };
}

function requireJob(id: string): ImportJob {
  const job = jobs.get(id);
  if (!job) throw new HttpError(404, "Import not found (it may have expired, or the manager restarted).");
  return job;
}

function newJob(source: ImportJob["source"], label: string, expectedBytes: number | null): ImportJob {
  const job: ImportJob = {
    id: crypto.randomUUID(),
    source,
    label,
    state: "receiving",
    receivedBytes: 0,
    expectedBytes,
    error: null,
    analysis: null,
    root: null,
    writingChunk: false,
    abort: new AbortController(),
    updatedAt: Date.now(),
  };
  fs.mkdirSync(filesDir(job.id), { recursive: true });
  jobs.set(job.id, job);
  return job;
}

function fail(job: ImportJob, err: unknown): void {
  job.state = "failed";
  job.error = err instanceof HttpError ? err.message : `Import failed: ${err instanceof Error ? err.message : String(err)}`;
  job.updatedAt = Date.now();
  appLogger.warn({ err, importId: job.id }, "import failed");
  // Nothing more can happen with a failed import's files; free the disk now.
  fs.rmSync(jobDir(job.id), { recursive: true, force: true });
}

/**
 * Runs a job's transfer/extraction/analysis in the background. A job
 * cancelled meanwhile is already out of `jobs`, but its work may still have
 * been writing into the staging dir — so its files are removed only once
 * that work has actually stopped.
 */
function runInBackground(job: ImportJob, work: () => Promise<void>): void {
  work().then(
    () => {
      if (job.abort.signal.aborted) fs.rmSync(jobDir(job.id), { recursive: true, force: true });
    },
    (err: unknown) => {
      if (job.abort.signal.aborted) fs.rmSync(jobDir(job.id), { recursive: true, force: true });
      else fail(job, err);
    }
  );
}

/** Locates the server inside the staged files, drops disposable dirs, and analyzes it. */
async function finalize(job: ImportJob, extraExcludes: string[] = [], warning: string | null = null): Promise<void> {
  const root = findServerRoot(filesDir(job.id));
  for (const dir of [...DISPOSABLE_DIRS, ...extraExcludes]) {
    fs.rmSync(path.join(root, dir), { recursive: true, force: true });
  }
  const analysis = await analyzeServer(root);
  if (warning) analysis.warnings.unshift(warning);
  job.root = root;
  job.analysis = analysis;
  job.state = "ready";
  job.updatedAt = Date.now();
  appLogger.info({ importId: job.id, serverType: analysis.serverType, version: analysis.minecraftVersion }, "import analyzed");
}

export const importJobs = {
  get(id: string): ImportJobView {
    return view(requireJob(id));
  },

  startUpload(fileName: string, sizeBytes: number): ImportJobView {
    if (sizeBytes > env.IMPORT_MAX_BYTES) {
      throw new HttpError(413, `That archive is larger than the import limit (IMPORT_MAX_BYTES).`);
    }
    const job = newJob("upload", path.basename(fileName), sizeBytes);
    fs.writeFileSync(archivePath(job.id), "");
    return view(job);
  },

  /**
   * Appends one chunk of an upload. Uploads arrive in chunks, in order, so a
   * multi-gigabyte server never has to fit in one request (Node's server
   * kills requests that take longer than 5 minutes to arrive), and a failed
   * chunk can be retried: it's written at its offset and truncated away again
   * on failure.
   */
  async appendChunk(id: string, offset: number, body: Readable): Promise<ImportJobView> {
    const job = requireJob(id);
    if (job.source !== "upload" || job.state !== "receiving") throw new HttpError(409, "This import isn't receiving an upload.");
    if (job.writingChunk) throw new HttpError(409, "Another chunk is still being written.");
    if (offset !== job.receivedBytes) throw new HttpError(409, `Expected the chunk at offset ${job.receivedBytes}.`);

    job.writingChunk = true;
    let written = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        written += chunk.length;
        if (written > MAX_CHUNK_BYTES || offset + written > job.expectedBytes!) {
          callback(new HttpError(413, "Chunk is larger than allowed, or runs past the declared file size."));
        } else {
          callback(null, chunk);
        }
      },
    });
    try {
      await pipeline(body, limit, fs.createWriteStream(archivePath(id), { flags: "r+", start: offset }));
      job.receivedBytes += written;
      job.updatedAt = Date.now();
      return view(job);
    } catch (err) {
      if (jobs.has(id)) fs.truncateSync(archivePath(id), job.receivedBytes);
      throw err;
    } finally {
      job.writingChunk = false;
    }
  },

  completeUpload(id: string): ImportJobView {
    const job = requireJob(id);
    if (job.source !== "upload" || job.state !== "receiving") throw new HttpError(409, "This import isn't receiving an upload.");
    if (job.writingChunk || job.receivedBytes !== job.expectedBytes) {
      throw new HttpError(409, `Upload incomplete: ${job.receivedBytes} of ${job.expectedBytes} bytes received.`);
    }
    job.state = "processing";
    job.updatedAt = Date.now();
    runInBackground(job, async () => {
      await extractArchiveFile(archivePath(id), filesDir(id), env.IMPORT_MAX_BYTES);
      fs.rmSync(archivePath(id), { force: true });
      if (!job.abort.signal.aborted) await finalize(job);
    });
    return view(job);
  },

  startSshPull(options: SshPullOptions): ImportJobView {
    const job = newJob("ssh", `${options.username}@${options.host}:${options.remotePath}`, null);
    runInBackground(job, async () => {
      const { warning } = await pullOverSsh(
        options,
        filesDir(job.id),
        env.IMPORT_MAX_BYTES,
        (bytes) => {
          job.receivedBytes = bytes;
          job.updatedAt = Date.now();
        },
        job.abort.signal
      );
      job.state = "processing";
      await finalize(job, options.exclude, warning);
    });
    return view(job);
  },

  /**
   * Hands a ready import's staged server directory to `deploy` (which copies
   * it into a new instance). The job is removed once that succeeds; if it
   * fails the files stay staged so the admin can adjust settings and retry.
   */
  async deploy<T>(id: string, deploy: (root: string, analysis: ImportAnalysis) => Promise<T>): Promise<T> {
    const job = requireJob(id);
    if (job.state !== "ready" || !job.root || !job.analysis) throw new HttpError(409, "This import isn't ready to deploy.");
    job.state = "deploying";
    job.error = null;
    try {
      const result = await deploy(job.root, job.analysis);
      jobs.delete(id);
      fs.rmSync(jobDir(id), { recursive: true, force: true });
      return result;
    } catch (err) {
      job.state = "ready";
      job.error = err instanceof HttpError ? err.message : "Deploy failed.";
      job.updatedAt = Date.now();
      throw err;
    }
  },

  remove(id: string): void {
    const job = requireJob(id);
    if (job.state === "deploying") throw new HttpError(409, "This import is being deployed.");
    job.abort.abort();
    jobs.delete(id);
    // Work still running in the background cleans up once it notices the abort.
    const backgroundWorkRunning = job.state === "processing" || (job.source === "ssh" && job.state === "receiving");
    if (!backgroundWorkRunning) fs.rmSync(jobDir(id), { recursive: true, force: true });
  },
};

/** Staged files from before a restart belong to jobs that no longer exist. */
export function clearImportStaging(): void {
  fs.rmSync(IMPORTS_DIR, { recursive: true, force: true });
  fs.mkdirSync(IMPORTS_DIR, { recursive: true });
}

/** Drops imports nobody has touched in a day — staged servers can be many GB. */
export function startAbandonedImportSweep(): void {
  setInterval(() => {
    for (const job of jobs.values()) {
      if (job.state === "deploying" || Date.now() - job.updatedAt < ABANDONED_AFTER_MS) continue;
      appLogger.info({ importId: job.id }, "removing abandoned import");
      importJobs.remove(job.id);
    }
  }, 60 * 60 * 1000).unref();
}
