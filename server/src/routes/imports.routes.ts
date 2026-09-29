import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireSuperadmin } from "../auth/middleware.js";
import { HttpError, routeParam } from "../http/errors.js";
import { instanceService } from "../instances/instanceService.js";
import { SERVER_TYPES } from "../imports/analyze.js";
import { KNOWN_JAVA_VERSIONS } from "../docker/javaImage.js";
import { importJobs } from "../imports/importJobs.js";
import { fetchHostKey } from "../imports/sshSource.js";
import { serializeInstance } from "./instances.routes.js";

/**
 * Importing an existing (natively run) server — see imports/importJobs.ts for
 * the staging flow. Superadmin-only throughout, like creating instances: an
 * import runs arbitrary server code, and the SSH source makes the manager
 * connect wherever it's told.
 */
export const importsRouter = Router();
importsRouter.use(requireAuth, requireSuperadmin);

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error));
  return parsed.data;
}

const startUploadSchema = z.object({
  fileName: z.string().min(1).max(255),
  sizeBytes: z.number().int().positive(),
});

importsRouter.post("/upload", (req, res) => {
  const { fileName, sizeBytes } = parse(startUploadSchema, req.body);
  res.status(201).json(importJobs.startUpload(fileName, sizeBytes));
});

// Raw chunk body (application/octet-stream) — streamed to disk, never buffered.
importsRouter.put("/:id/upload", async (req, res) => {
  const { offset } = parse(z.object({ offset: z.coerce.number().int().nonnegative() }), req.query);
  res.json(await importJobs.appendChunk(routeParam(req, "id"), offset, req));
});

importsRouter.post("/:id/upload/complete", (req, res) => {
  res.json(importJobs.completeUpload(routeParam(req, "id")));
});

const sshTargetSchema = z.object({
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(22),
});

importsRouter.post("/ssh/host-key", async (req, res) => {
  res.json(await fetchHostKey(parse(sshTargetSchema, req.body)));
});

const EXCLUDABLE_DIR = /^[A-Za-z0-9._-]+$/;

const sshPullSchema = sshTargetSchema
  .extend({
    username: z.string().trim().min(1).max(64),
    password: z.string().max(1024).optional(),
    privateKey: z.string().max(16384).optional(),
    passphrase: z.string().max(1024).optional(),
    remotePath: z.string().trim().min(1).max(1024),
    useSudo: z.boolean().default(false),
    exclude: z
      .array(z.string().regex(EXCLUDABLE_DIR).refine((d) => d !== "." && d !== ".."))
      .max(20)
      .default([]),
    hostFingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/, "Confirm the host key fingerprint first."),
  })
  .refine((v) => v.password || v.privateKey, "Provide a password or a private key.");

importsRouter.post("/ssh", (req, res) => {
  res.status(201).json(importJobs.startSshPull(parse(sshPullSchema, req.body)));
});

importsRouter.get("/:id", (req, res) => {
  res.json(importJobs.get(routeParam(req, "id")));
});

importsRouter.delete("/:id", (req, res) => {
  importJobs.remove(routeParam(req, "id"));
  res.status(204).end();
});

const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const optionalVersion = z
  .string()
  .trim()
  .transform((v) => v || undefined)
  .pipe(z.string().regex(VERSION, "Versions may only contain letters, digits and . _ + -").optional())
  .optional();

const deploySchema = z.object({
  name: z.string().min(1),
  subdomain: z.string().min(1),
  memoryMb: z.number().int().min(512),
  serverType: z.enum(SERVER_TYPES),
  minecraftVersion: optionalVersion,
  loaderVersion: optionalVersion,
  customJar: z.string().optional(),
  javaVersion: z
    .number()
    .int()
    .refine((v) => (KNOWN_JAVA_VERSIONS as readonly number[]).includes(v), "Unsupported Java version.")
    .nullable(),
});

importsRouter.post("/:id/deploy", async (req, res) => {
  const input = parse(deploySchema, req.body);
  const instance = await importJobs.deploy(routeParam(req, "id"), (root, analysis) =>
    instanceService.createImportedInstance(input, root, analysis)
  );
  res.status(201).json(serializeInstance(instance, req.user!));
});
