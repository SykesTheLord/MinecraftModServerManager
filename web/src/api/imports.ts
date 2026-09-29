import { api, ApiError } from "./client";
import type { Instance, ImportJob, ServerType } from "./types";

export interface SshPullInput {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  remotePath: string;
  useSudo: boolean;
  exclude: string[];
  hostFingerprint: string;
}

export interface DeployImportInput {
  name: string;
  subdomain: string;
  memoryMb: number;
  serverType: ServerType;
  minecraftVersion?: string;
  loaderVersion?: string;
  customJar?: string;
  javaVersion: number | null;
}

// Chunks keep every request well under the server's per-request limits and
// make a dropped connection cost one chunk, not the whole upload.
const CHUNK_BYTES = 32 * 1024 * 1024;
const CHUNK_ATTEMPTS = 4;

async function putChunk(id: string, offset: number, chunk: Blob): Promise<ImportJob> {
  const res = await fetch(`/api/imports/${id}/upload?offset=${offset}`, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/octet-stream" },
    body: chunk,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body?.error ?? `Upload failed (${res.status})`);
  return body as ImportJob;
}

export const importsApi = {
  get: (id: string) => api.get<ImportJob>(`/imports/${id}`),
  cancel: (id: string) => api.delete<void>(`/imports/${id}`),
  hostKey: (host: string, port: number) =>
    api.post<{ fingerprint: string; keyType: string }>("/imports/ssh/host-key", { host, port }),
  startSsh: (input: SshPullInput) => api.post<ImportJob>("/imports/ssh", input),
  deploy: (id: string, input: DeployImportInput) => api.post<Instance>(`/imports/${id}/deploy`, input),

  /** Uploads an archive in order, chunk by chunk, retrying failed chunks from where the server says it is. */
  async upload(file: File, onProgress: (sentBytes: number) => void, signal: AbortSignal): Promise<ImportJob> {
    let job = await api.post<ImportJob>("/imports/upload", { fileName: file.name, sizeBytes: file.size });
    let failures = 0;
    while (job.receivedBytes < file.size) {
      if (signal.aborted) throw new ApiError(0, "Upload cancelled.");
      const offset = job.receivedBytes;
      try {
        job = await putChunk(job.id, offset, file.slice(offset, offset + CHUNK_BYTES));
        failures = 0;
      } catch (err) {
        // Network errors, server errors and offset conflicts are worth retrying; a 4xx like 413 isn't.
        const retryable = !(err instanceof ApiError) || err.status >= 500 || err.status === 409;
        if (!retryable || ++failures >= CHUNK_ATTEMPTS) throw err;
        await new Promise((resolve) => setTimeout(resolve, 1000 * failures));
        job = await importsApi.get(job.id); // resync the offset
      }
      onProgress(job.receivedBytes);
    }
    return api.post<ImportJob>(`/imports/${job.id}/upload/complete`);
  },
};
