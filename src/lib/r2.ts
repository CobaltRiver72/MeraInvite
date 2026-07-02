// Cloudflare R2 (S3-compatible). Private bucket is reachable ONLY via these
// short-lived presigned URLs. Server-only.
import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

const PRIVATE = process.env.R2_PRIVATE_BUCKET!;

// Short-lived download link for a private object (default 10 min).
export function presignGet(key: string, expiresSeconds = 600) {
  return getSignedUrl(r2, new GetObjectCommand({ Bucket: PRIVATE, Key: key }), {
    expiresIn: expiresSeconds,
  });
}

// Fetch a private master (server-side render reads the clean background here;
// the bytes never reach the browser).
export async function getPrivateObject(key: string): Promise<Buffer> {
  const out = await r2.send(new GetObjectCommand({ Bucket: PRIVATE, Key: key }));
  const chunks: Uint8Array[] = [];
  // @ts-expect-error Node stream
  for await (const c of out.Body) chunks.push(c);
  return Buffer.concat(chunks);
}

// Store a rendered output into the private bucket.
export async function putPrivateObject(key: string, body: Buffer, contentType = "image/png") {
  await r2.send(new PutObjectCommand({ Bucket: PRIVATE, Key: key, Body: body, ContentType: contentType }));
  return key;
}

// Cache check — does this rendered file already exist? (skip re-render = save compute)
export async function privateObjectExists(key: string) {
  try {
    await r2.send(new HeadObjectCommand({ Bucket: PRIVATE, Key: key }));
    return true;
  } catch {
    return false;
  }
}

// Delete every object under a prefix (used on refund/revoke to kill all cached
// renders for an order — once gone, any outstanding presigned URL 404s).
export async function deletePrivatePrefix(prefix: string) {
  let token: string | undefined;
  do {
    const list = await r2.send(new ListObjectsV2Command({ Bucket: PRIVATE, Prefix: prefix, ContinuationToken: token }));
    const objs = (list.Contents ?? []).map((o) => ({ Key: o.Key! }));
    if (objs.length) {
      await r2.send(new DeleteObjectsCommand({ Bucket: PRIVATE, Delete: { Objects: objs } }));
    }
    token = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (token);
}
