import { useSyncExternalStore } from "react";
import { importsApi } from "../api/imports";
import { errorMessage } from "../api/client";
import type { ImportJob } from "../api/types";

/**
 * Archive uploads for imports, run outside any page component, so one keeps
 * going while the admin moves around the app (the import page, the
 * dashboard, a server's console…). Only this browser tab can send the file,
 * so closing or reloading the tab does stop it — the browser asks first
 * while an upload is running. Progress itself comes from the server's job.
 */
interface LocalUpload {
  controller: AbortController;
  /** Set once the upload failed for good (it's no longer running). */
  error: string | null;
}

const uploads = new Map<string, LocalUpload>();
const listeners = new Set<() => void>();
let version = 0;

function changed() {
  version++;
  for (const listener of listeners) listener();
}

const running = () => [...uploads.values()].some((u) => !u.error);

window.addEventListener("beforeunload", (e) => {
  if (running()) e.preventDefault(); // the browser shows its own "leave site?" prompt
});

/** Creates the import job and starts sending the file to it in the background; resolves with the new job. */
export async function beginUpload(file: File): Promise<ImportJob> {
  const job = await importsApi.startUpload(file);
  const upload: LocalUpload = { controller: new AbortController(), error: null };
  uploads.set(job.id, upload);
  changed();
  importsApi.sendUpload(job, file, upload.controller.signal).then(
    () => {
      uploads.delete(job.id);
      changed();
    },
    (err: unknown) => {
      if (upload.controller.signal.aborted) uploads.delete(job.id);
      else upload.error = errorMessage(err, "The upload failed.");
      changed();
    }
  );
  return job;
}

/** Stops sending an upload (cancelling the import itself is up to the caller). */
export function stopUpload(jobId: string): void {
  uploads.get(jobId)?.controller.abort();
  uploads.delete(jobId);
  changed();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * This tab's part in an upload import: `running` while it's sending the
 * file, `error` if sending failed. Neither means this tab never had (or no
 * longer has) the file — e.g. the page was reloaded mid-upload.
 */
export function useLocalUpload(jobId: string | undefined): { running: boolean; error: string | null } {
  useSyncExternalStore(subscribe, () => version);
  const upload = jobId ? uploads.get(jobId) : undefined;
  return { running: Boolean(upload && !upload.error), error: upload?.error ?? null };
}
