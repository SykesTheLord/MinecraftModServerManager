import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { importsApi } from "../api/imports";
import { errorMessage } from "../api/client";
import { Layout } from "../components/Layout";
import { PageHeader } from "../components/PageHeader";
import { Tabs } from "../components/Tabs";
import { ImportsList } from "../components/ImportsList";
import { CopyButton } from "../components/CopyButton";
import { beginUpload, stopUpload, useLocalUpload } from "../lib/uploads";
import { useBaseDomain } from "../hooks/useBaseDomain";
import { formatBytes, formatMemory, slugify, SUBDOMAIN_HINT, SUBDOMAIN_PATTERN } from "../lib/format";
import type { ImportAnalysis, ImportJob, ServerType } from "../api/types";

const MEMORY_OPTIONS = [2048, 4096, 6144, 8192, 12288, 16384];

const SERVER_TYPE_LABELS: Record<ServerType, string> = {
  FORGE: "Forge",
  NEOFORGE: "NeoForge",
  FABRIC: "Fabric",
  QUILT: "Quilt",
  PAPER: "Paper",
  VANILLA: "Vanilla",
  CUSTOM: "Custom jar",
};

/** Label for the loader version field, and whether it's optional; null hides the field. */
const LOADER_FIELD: Record<ServerType, { label: string; optional: boolean } | null> = {
  FORGE: { label: "Forge version", optional: false },
  NEOFORGE: { label: "NeoForge version", optional: false },
  FABRIC: { label: "Fabric loader version", optional: true },
  QUILT: { label: "Quilt loader version", optional: true },
  PAPER: { label: "Paper build", optional: true },
  VANILLA: null,
  CUSTOM: null,
};

/**
 * One import per URL (/instances/import/<jobId>): the work runs on the server
 * (and, for an upload, in this tab), so the admin can leave and come back —
 * from the list here or on the dashboard — without losing it.
 */
export function ImportServerPage() {
  const { jobId } = useParams<{ jobId?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const localUpload = useLocalUpload(jobId);

  const { data: job, error: jobError } = useQuery({
    queryKey: ["import", jobId],
    queryFn: () => importsApi.get(jobId!),
    enabled: !!jobId,
    retry: false,
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === "receiving" || state === "processing" || state === "deploying" ? 1000 : false;
    },
  });

  // Deployed while this page was open (or opened afterwards): go to the new server and dismiss the import.
  useEffect(() => {
    if (job?.state !== "deployed" || !job.instanceId) return;
    void importsApi.cancel(job.id).catch(() => undefined);
    void queryClient.invalidateQueries({ queryKey: ["imports"] });
    void queryClient.invalidateQueries({ queryKey: ["instances"] });
    navigate(`/instances/${job.instanceId}`, { replace: true });
  }, [job, navigate, queryClient]);

  const started = (id: string) => {
    void queryClient.invalidateQueries({ queryKey: ["imports"] });
    navigate(`/instances/import/${id}`);
  };
  const reset = () => {
    if (jobId) {
      stopUpload(jobId);
      void importsApi.cancel(jobId).catch(() => undefined);
      queryClient.removeQueries({ queryKey: ["import", jobId] });
    }
    void queryClient.invalidateQueries({ queryKey: ["imports"] });
    navigate("/instances/import");
  };

  return (
    <Layout narrow title="Import a server">
      <Link to={jobId ? "/instances/import" : "/"} className="back-link">
        {jobId ? "← All imports" : "← Servers"}
      </Link>
      <PageHeader
        title="Import a server"
        subtitle="Bring over a server that's been running natively (e.g. on an Ubuntu machine) — its mods, configs and world move into a container here."
      />

      {!jobId && (
        <>
          <div className="callout warning">
            <p>Stop the server on the old machine first, so its world is saved and not changing while it's copied.</p>
          </div>
          <ImportsList title="Imports in progress" />
          <SourceStep onStarted={started} />
        </>
      )}

      {jobId && !job && !jobError && (
        <div className="page-loading">
          <span className="spinner" aria-label="Loading" />
        </div>
      )}
      {jobError && (
        <section className="card">
          <h2>This import isn't available</h2>
          <p className="muted">
            {errorMessage(jobError, "Couldn't load the import.")} Finished imports appear on the dashboard as servers.
          </p>
          <Link to="/instances/import" className="button-link">
            Start a new import
          </Link>
        </section>
      )}

      {job && (job.state === "receiving" || job.state === "processing") && (
        <ProgressStep job={job} localUpload={localUpload} onCancel={reset} />
      )}

      {job?.state === "failed" && (
        <section className="card">
          <h2>Import failed</h2>
          <p className="error-text">{job.error}</p>
          <button onClick={reset}>Start over</button>
        </section>
      )}

      {job && (job.state === "ready" || job.state === "deploying") && job.analysis && (
        <ReviewStep job={job} analysis={job.analysis} onCancel={reset} />
      )}
    </Layout>
  );
}

function SourceStep({ onStarted }: { onStarted: (jobId: string) => void }) {
  const [tab, setTab] = useState<"ssh" | "upload">("ssh");
  return (
    <section className="card">
      <h2>1. Where is the server?</h2>
      <Tabs
        label="Import source"
        value={tab}
        onChange={setTab}
        options={[
          { value: "ssh", label: "Copy from another machine (SSH)" },
          { value: "upload", label: "Upload an archive" },
        ]}
      />
      {tab === "ssh" ? <SshSourceForm onStarted={onStarted} /> : <UploadSourceForm onStarted={onStarted} />}
    </section>
  );
}

function UploadSourceForm({ onStarted }: { onStarted: (jobId: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  // Creates the job and hands the file to the background uploader (lib/uploads.ts), which keeps
  // sending it while you move around the app.
  const upload = useMutation({ mutationFn: (f: File) => beginUpload(f), onSuccess: (job) => onStarted(job.id) });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (file) upload.mutate(file);
      }}
    >
      <p className="muted">
        A <code>.tar.gz</code>, <code>.tar</code> or <code>.zip</code> of the server's directory. On the old machine, for
        example: <code>tar -czf server.tar.gz -C /opt/minecraft/server .</code> (or use{" "}
        <code>scripts/export-native-server.sh</code> from this repo, which also skips logs and backups).
      </p>
      <label>
        Archive
        <input
          type="file"
          accept=".tar,.tar.gz,.tgz,.zip,application/gzip,application/zip,application/x-tar"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          disabled={upload.isPending}
          required
        />
      </label>
      <p className="hint">
        The upload carries on while you use the rest of the app; just keep this browser tab open until it's done.
      </p>
      {upload.isError && <p className="error-text">{errorMessage(upload.error, "Couldn't start the upload.")}</p>}
      <div className="form-actions">
        <button type="submit" disabled={!file || upload.isPending}>
          {upload.isPending ? "Starting…" : "Upload"}
        </button>
      </div>
    </form>
  );
}

function hostKeyFileFor(keyType: string): string {
  if (keyType === "ssh-ed25519") return "/etc/ssh/ssh_host_ed25519_key.pub";
  if (keyType.startsWith("ecdsa-")) return "/etc/ssh/ssh_host_ecdsa_key.pub";
  return "/etc/ssh/ssh_host_rsa_key.pub";
}

function SshSourceForm({ onStarted }: { onStarted: (jobId: string) => void }) {
  const [host, setHost] = useState("");
  const [port, setPort] = useState(22);
  const [username, setUsername] = useState("");
  // The host's own SSH keys (shared read-only with the manager); used by default when there are any.
  const { data: localKeys } = useQuery({ queryKey: ["local-ssh-keys"], queryFn: importsApi.localKeys });
  const [chosenAuthMode, setAuthMode] = useState<"local" | "password" | "key" | null>(null);
  const hasLocalKeys = Boolean(localKeys?.length);
  const authMode = chosenAuthMode === "local" && !hasLocalKeys ? "password" : (chosenAuthMode ?? (hasLocalKeys ? "local" : "password"));
  const [chosenLocalKey, setLocalKey] = useState<string | null>(null);
  const localKey = localKeys?.find((k) => k.name === chosenLocalKey) ?? localKeys?.find((k) => !k.encrypted) ?? localKeys?.[0];
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [remotePath, setRemotePath] = useState("");
  const [useSudo, setUseSudo] = useState(false);
  const [skipBackups, setSkipBackups] = useState(true);
  const [hostKey, setHostKey] = useState<{ fingerprint: string; keyType: string } | null>(null);
  const [hostKeyConfirmed, setHostKeyConfirmed] = useState(false);

  // A fingerprint only vouches for the host/port it was fetched from.
  const setTarget = (nextHost: string, nextPort: number) => {
    setHost(nextHost);
    setPort(nextPort);
    setHostKey(null);
    setHostKeyConfirmed(false);
  };

  const checkHostKey = useMutation({
    mutationFn: () => importsApi.hostKey(host.trim(), port),
    onSuccess: (key) => {
      setHostKey(key);
      setHostKeyConfirmed(false);
    },
  });

  const start = useMutation({
    mutationFn: () =>
      importsApi.startSsh({
        host: host.trim(),
        port,
        username,
        ...(authMode === "local"
          ? { localKey: localKey!.name, passphrase: passphrase || undefined }
          : authMode === "password"
            ? { password }
            : { privateKey, passphrase: passphrase || undefined }),
        remotePath,
        useSudo,
        exclude: skipBackups ? ["backups"] : [],
        hostFingerprint: hostKey!.fingerprint,
      }),
    onSuccess: (job) => onStarted(job.id),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!hostKey) checkHostKey.mutate();
        else start.mutate();
      }}
    >
      <p className="muted">
        The manager connects to the old machine over SSH and copies the server directory with <code>tar</code> (present
        on every Ubuntu install). Credentials are only used for this transfer and are never stored.
      </p>
      <div className="form-row">
        <label>
          Host
          <input value={host} onChange={(e) => setTarget(e.target.value, port)} placeholder="192.168.1.20" required />
        </label>
        <label className="port-field">
          Port
          <input
            type="number"
            min={1}
            max={65535}
            value={port}
            onChange={(e) => setTarget(host, Number(e.target.value))}
            required
          />
        </label>
      </div>

      {hostKey && (
        <div className="card">
          <p>
            <strong>Host key ({hostKey.keyType}):</strong>
          </p>
          <p className="fingerprint">{hostKey.fingerprint}</p>
          <p className="muted">
            Check this matches the server by running this on the old machine itself:{" "}
            <code>ssh-keygen -lf {hostKeyFileFor(hostKey.keyType)}</code>. If it doesn't, don't continue — the
            connection isn't going where you think it is.
          </p>
          <label className="checkbox">
            <input type="checkbox" checked={hostKeyConfirmed} onChange={(e) => setHostKeyConfirmed(e.target.checked)} />
            The fingerprint matches
          </label>
        </div>
      )}

      {hostKey && hostKeyConfirmed && (
        <>
          <label>
            SSH username
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" required />
          </label>
          <Tabs
            label="SSH authentication"
            value={authMode}
            onChange={(mode) => {
              setAuthMode(mode);
              setPassphrase("");
            }}
            options={[
              ...(hasLocalKeys ? [{ value: "local" as const, label: "This host's SSH key" }] : []),
              { value: "password" as const, label: "Password" },
              { value: "key" as const, label: "Paste a private key" },
            ]}
          />
          {authMode === "local" && localKey ? (
            <>
              <label>
                Key
                <select
                  value={localKey.name}
                  onChange={(e) => {
                    setLocalKey(e.target.value);
                    setPassphrase("");
                  }}
                >
                  {localKeys!.map((k) => (
                    <option key={k.name} value={k.name}>
                      {k.name}
                      {k.type ? ` (${k.type.replace(/^ssh-/, "")})` : ""}
                      {k.comment ? ` — ${k.comment}` : ""}
                      {k.encrypted ? " · passphrase" : ""}
                    </option>
                  ))}
                </select>
                <span className="hint">
                  From the SSH keys of the user who runs this manager, shared with it read-only. The private key stays on
                  this host; it's never sent to your browser.
                </span>
              </label>
              {localKey.fingerprint && <p className="fingerprint">{localKey.fingerprint}</p>}
              {localKey.publicKey && (
                <details>
                  <summary className="muted">Not set up on the old machine yet?</summary>
                  <p className="muted">
                    Add this line to <code>~/.ssh/authorized_keys</code> of the SSH user above, on the old machine:
                  </p>
                  <p className="fingerprint">
                    {localKey.publicKey} <CopyButton text={localKey.publicKey} />
                  </p>
                </details>
              )}
              {localKey.encrypted && (
                <label>
                  Key passphrase
                  <input
                    type="password"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    autoComplete="off"
                    required
                  />
                </label>
              )}
            </>
          ) : authMode === "password" ? (
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="off"
                required
              />
            </label>
          ) : (
            <>
              <label>
                Private key (OpenSSH/PEM)
                <textarea
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  spellCheck={false}
                  required
                />
              </label>
              <label>
                Key passphrase (if any)
                <input
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  autoComplete="off"
                />
              </label>
            </>
          )}
          <label>
            Server directory on that machine
            <input
              value={remotePath}
              onChange={(e) => setRemotePath(e.target.value)}
              placeholder="/opt/minecraft/server"
              pattern="/.*"
              title="An absolute path, starting with /"
              required
            />
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={useSudo} onChange={(e) => setUseSudo(e.target.checked)} />
            Read the files with sudo (if they belong to another user, e.g. a <code>minecraft</code> service account —
            needs passwordless sudo)
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={skipBackups} onChange={(e) => setSkipBackups(e.target.checked)} />
            Skip the <code>backups/</code> folder
          </label>
        </>
      )}

      {checkHostKey.isError && <p className="error-text">{errorMessage(checkHostKey.error, "Couldn't reach that host.")}</p>}
      {start.isError && <p className="error-text">{errorMessage(start.error, "Couldn't start the import.")}</p>}

      {!hostKey ? (
        <button type="submit" disabled={checkHostKey.isPending || !host.trim()}>
          {checkHostKey.isPending ? "Connecting…" : "Check host key"}
        </button>
      ) : (
        <button type="submit" disabled={!hostKeyConfirmed || start.isPending}>
          {start.isPending ? "Starting…" : "Copy server"}
        </button>
      )}
    </form>
  );
}

function ProgressStep({
  job,
  localUpload,
  onCancel,
}: {
  job: ImportJob;
  localUpload: { running: boolean; error: string | null };
  onCancel: () => void;
}) {
  const receiving = job.state === "receiving";
  // An upload only this tab could have been sending: if it isn't (any more), nothing will finish it.
  const uploadOrphaned = receiving && job.source === "upload" && !localUpload.running;
  return (
    <section className="card">
      <h2>2. {receiving ? (job.source === "upload" ? "Uploading" : "Copying") : "Unpacking and analyzing"}</h2>
      <p className="muted">{job.label}</p>
      {uploadOrphaned ? (
        <div className="callout danger">
          <p>
            {localUpload.error
              ? `The upload stopped: ${localUpload.error}`
              : "This upload was being sent from a browser tab that has since been closed or reloaded, so it can't continue."}{" "}
            Start over to upload the archive again.
          </p>
        </div>
      ) : receiving ? (
        <div className="progress-row">
          {job.expectedBytes ? <progress value={job.receivedBytes} max={job.expectedBytes} /> : <progress />}
          <span className="muted">
            {formatBytes(job.receivedBytes)} received{job.source === "ssh" ? " (compressed)" : ""}
            {job.expectedBytes ? ` of ${formatBytes(job.expectedBytes)}` : ""}
          </span>
        </div>
      ) : (
        <div className="progress-row">
          <progress />
          <span className="muted">This can take a few minutes for a large server.</span>
        </div>
      )}
      {!uploadOrphaned && (
        <p className="hint">
          {job.source === "upload" && receiving
            ? "You can use the rest of the app meanwhile — the upload continues as long as this browser tab stays open. Come back here (or to the dashboard) to pick it up."
            : "This runs on the server: you can leave this page, or close the browser, and pick it up later from the dashboard or the import page."}
        </p>
      )}
      <button className={uploadOrphaned ? undefined : "secondary"} onClick={onCancel}>
        {uploadOrphaned ? "Start over" : "Cancel"}
      </button>
    </section>
  );
}

function ReviewStep({ job, analysis, onCancel }: { job: ImportJob; analysis: ImportAnalysis; onCancel: () => void }) {
  const queryClient = useQueryClient();
  const deploying = job.state === "deploying";
  const baseDomain = useBaseDomain();

  const initialName = analysis.motd?.replace(/§./g, "").trim().slice(0, 60) ?? "";
  const [name, setName] = useState(initialName);
  // Follows the name until the subdomain is edited by hand.
  const [subdomainEdited, setSubdomainEdited] = useState(false);
  const [subdomainDraft, setSubdomain] = useState("");
  const subdomain = subdomainEdited ? subdomainDraft : slugify(name);
  const [memoryMb, setMemoryMb] = useState(analysis.memoryMb ?? 4096);
  const [serverType, setServerType] = useState<ServerType>(analysis.serverType);
  const [minecraftVersion, setMinecraftVersion] = useState(analysis.minecraftVersion ?? "");
  const [loaderVersion, setLoaderVersion] = useState(analysis.loaderVersion ?? "");
  const [customJar, setCustomJar] = useState(analysis.customJar ?? analysis.jars[0] ?? "");
  const [javaVersion, setJavaVersion] = useState<number | null>(null);

  const memoryOptions = MEMORY_OPTIONS.includes(memoryMb) ? MEMORY_OPTIONS : [...MEMORY_OPTIONS, memoryMb].sort((a, b) => a - b);
  const loaderField = LOADER_FIELD[serverType];

  const deploy = useMutation({
    mutationFn: () =>
      importsApi.deploy(job.id, {
        name,
        subdomain,
        memoryMb,
        serverType,
        minecraftVersion: minecraftVersion || undefined,
        loaderVersion: loaderField ? loaderVersion || undefined : undefined,
        customJar: serverType === "CUSTOM" ? customJar : undefined,
        javaVersion,
      }),
    // The copy runs on the server; the page polls the job and moves on to the server once it's deployed.
    onSuccess: (updated) => {
      queryClient.setQueryData(["import", job.id], updated);
      void queryClient.invalidateQueries({ queryKey: ["imports"] });
    },
  });
  const error = deploy.isError ? errorMessage(deploy.error, "Deploy failed.") : !deploying ? job.error : null;

  return (
    <section className="card">
      <h2>3. Review and deploy</h2>
      <p className="muted">{job.label}</p>
      <ul className="facts" aria-label="Detected">
        <li className="chip accent">
          {SERVER_TYPE_LABELS[analysis.serverType]}
          {analysis.minecraftVersion && ` ${analysis.minecraftVersion}`}
          {analysis.loaderVersion && ` (${analysis.loaderVersion})`}
        </li>
        <li className="chip">
          {analysis.modCount} mod{analysis.modCount === 1 ? "" : "s"}
        </li>
        <li className="chip">{formatBytes(analysis.totalBytes)}</li>
        <li className={analysis.worldFound ? "chip" : "chip warning"}>
          World <code>{analysis.levelName}/</code> {analysis.worldFound ? "found" : "not found"}
        </li>
      </ul>
      {analysis.warnings.length > 0 && (
        <ul className="warning-list">
          {analysis.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          deploy.mutate();
        }}
      >
        <fieldset className="plain-fieldset" disabled={deploying || deploy.isPending}>
          <label>
            Display name
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label>
            Subdomain
            <div className="subdomain-input">
              <input
                value={subdomain}
                onChange={(e) => {
                  setSubdomainEdited(true);
                  setSubdomain(e.target.value.toLowerCase());
                }}
                pattern={SUBDOMAIN_PATTERN}
                title={SUBDOMAIN_HINT}
                spellCheck={false}
                required
              />
              <span>.{baseDomain ?? "…"}</span>
            </div>
          </label>
          <label>
            Memory (heap)
            <select value={memoryMb} onChange={(e) => setMemoryMb(Number(e.target.value))}>
              {memoryOptions.map((mb) => (
                <option key={mb} value={mb}>
                  {formatMemory(mb)}
                  {mb === analysis.memoryMb ? " (from the old server's -Xmx)" : ""}
                </option>
              ))}
            </select>
          </label>

          <div className="form-row">
            <label>
              Platform
              <select value={serverType} onChange={(e) => setServerType(e.target.value as ServerType)}>
                {Object.entries(SERVER_TYPE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Minecraft version{serverType === "CUSTOM" && " (optional)"}
              <input
                value={minecraftVersion}
                onChange={(e) => setMinecraftVersion(e.target.value.trim())}
                placeholder="1.20.1"
                required={serverType !== "CUSTOM"}
              />
            </label>
            {loaderField && (
              <label>
                {loaderField.label}
                {loaderField.optional && " (optional)"}
                <input
                  value={loaderVersion}
                  onChange={(e) => setLoaderVersion(e.target.value.trim())}
                  placeholder={loaderField.optional ? "latest" : ""}
                  required={!loaderField.optional}
                />
              </label>
            )}
          </div>

          {serverType === "CUSTOM" && (
            <label>
              Server jar
              <select value={customJar} onChange={(e) => setCustomJar(e.target.value)} required>
                {analysis.jars.length === 0 && <option value="">No jars found in the server directory</option>}
                {analysis.jars.map((jar) => (
                  <option key={jar} value={jar}>
                    {jar}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label>
            Java version
            <select
              value={javaVersion ?? ""}
              onChange={(e) => setJavaVersion(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">Automatic (from the Minecraft version)</option>
              {analysis.javaVersions.map((v) => (
                <option key={v} value={v}>
                  Java {v}
                </option>
              ))}
            </select>
          </label>
          <p className="muted">
            The container installs the {SERVER_TYPE_LABELS[serverType]} version above itself on first boot, next to the
            copied mods, configs and world; the old machine's start scripts aren't used. The port and bind address in{" "}
            <code>server.properties</code> are reset so the server is reachable through the shared port 25565.
          </p>
        </fieldset>

        {deploying && (
          <div className="callout info">
            <span className="spinner" aria-hidden="true" />
            <p>
              Copying the server into its new container, then starting it. This runs on the server — you can leave this
              page; the server shows up on the dashboard once it's created.
            </p>
          </div>
        )}
        {error && <p className="error-text">{error}</p>}
        <div className="form-actions">
          <button type="submit" disabled={deploy.isPending || deploying}>
            {deploy.isPending || deploying ? "Deploying (copying files)…" : "Deploy"}
          </button>
          <button type="button" className="secondary" onClick={onCancel} disabled={deploy.isPending || deploying}>
            Discard import
          </button>
        </div>
      </form>
    </section>
  );
}
