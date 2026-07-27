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

export function patchObjectKey(input: {
  prefix: string;
  runId: string;
  phaseName: string;
}): string {
  const prefix = input.prefix.replace(/\/+$/, "");
  return `${prefix}/${segment(input.runId)}/${segment(input.phaseName)}.patch`;
}
