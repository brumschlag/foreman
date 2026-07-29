/**
 * Patch transport for kelos phases.
 *
 * A kelos agent runs in a pod whose filesystem Foreman cannot see, so the phase's
 * work has to travel back as an artifact. The agent uploads a git patch to object
 * storage with a presigned URL — no credentials or SDK in the pod — and Foreman
 * downloads and applies it. The pod can be reclaimed immediately afterwards,
 * unlike a transport that reads from the live pod.
 *
 * @module kelos-patch-store
 */

/** Storage seam: nothing else in the orchestrator couples to a specific provider. */
export interface PatchStore {
  /** URL the agent can PUT the patch to, valid for a short window. */
  presignPut(key: string): Promise<string>;
  /** Fetch an uploaded patch. Returns null when the agent uploaded nothing. */
  get(key: string): Promise<string | null>;
  /**
   * Upload a seed patch of Foreman's accumulated worktree state.
   *
   * Each kelos phase runs in a fresh clone, so without a seed a phase cannot see
   * earlier phases' work — a verdict phase then reports the task's own output
   * missing. Optional so existing stubs and the non-seeding path keep working.
   */
  put?(key: string, body: string): Promise<void>;
  /** URL the pod can GET the seed from, so it needs no AWS credentials. */
  presignGet?(key: string): Promise<string>;
}

/** Keeps a path segment inside the prefix — ids reach here from task metadata. */
function segment(value: string): string {
  // Dots are dropped entirely rather than collapsed: keeping them admits ".."
  // through paths like "dev/../.." once separators become dashes.
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-");
  return cleaned.replace(/^-+|-+$/g, "") || "unknown";
}

export interface S3PatchStoreOptions {
  bucket: string;
  region?: string;
  /** Presigned PUT lifetime. Long enough for a slow phase, short enough to expire. */
  expiresInSeconds?: number;
}

export function createS3PatchStore(options: S3PatchStoreOptions): PatchStore {
  return {
    async presignPut(key: string): Promise<string> {
      const [{ S3Client, PutObjectCommand }, { getSignedUrl }] = await Promise.all([
        import("@aws-sdk/client-s3"),
        import("@aws-sdk/s3-request-presigner"),
      ]);
      const client = new S3Client({ region: options.region });
      return getSignedUrl(
        client,
        new PutObjectCommand({ Bucket: options.bucket, Key: key }),
        { expiresIn: options.expiresInSeconds ?? 3600 },
      );
    },

    async put(key: string, body: string): Promise<void> {
      const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
      const client = new S3Client({ region: options.region });
      await client.send(
        new PutObjectCommand({ Bucket: options.bucket, Key: key, Body: body }),
      );
    },

    async presignGet(key: string): Promise<string> {
      const [{ S3Client, GetObjectCommand }, { getSignedUrl }] = await Promise.all([
        import("@aws-sdk/client-s3"),
        import("@aws-sdk/s3-request-presigner"),
      ]);
      const client = new S3Client({ region: options.region });
      return getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: options.bucket, Key: key }),
        { expiresIn: options.expiresInSeconds ?? 3600 },
      );
    },

    async get(key: string): Promise<string | null> {
      const { S3Client, GetObjectCommand, NoSuchKey } = await import("@aws-sdk/client-s3");
      const client = new S3Client({ region: options.region });
      try {
        const res = await client.send(
          new GetObjectCommand({ Bucket: options.bucket, Key: key }),
        );
        return (await res.Body?.transformToString()) ?? null;
      } catch (err) {
        // A missing object means the phase uploaded nothing, which is a normal
        // outcome for a read-only phase — not a transport failure.
        if (err instanceof NoSuchKey) return null;
        throw err;
      }
    },
  };
}

/**
 * Key for the seed patch handed to a phase before its agent starts.
 *
 * Kept separate from `patchObjectKey` so a phase's input and output never share a
 * key, and scoped per phase so a retry cannot read a seed built for an earlier
 * attempt of a different phase.
 */
export function seedObjectKey(input: {
  prefix: string;
  runId: string;
  phaseName: string;
}): string {
  const prefix = input.prefix.replace(/\/+$/, "");
  return `${prefix}/${segment(input.runId)}/${segment(input.phaseName)}.seed.patch`;
}

export function patchObjectKey(input: {
  prefix: string;
  runId: string;
  phaseName: string;
}): string {
  const prefix = input.prefix.replace(/\/+$/, "");
  return `${prefix}/${segment(input.runId)}/${segment(input.phaseName)}.patch`;
}
