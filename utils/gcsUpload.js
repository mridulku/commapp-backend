// ───────────────────────────────────────── utils/gcsUpload.js
const { Storage } = require("@google-cloud/storage");
const path        = require("path");

const bucketName  = process.env.GCS_BUCKET;            // e.g. "comm-app-ff74b"
if (!bucketName) throw new Error("GCS_BUCKET env var missing");

const storage     = new Storage();                     // uses GOOGLE_APPLICATION_CREDENTIALS
const bucket      = storage.bucket(bucketName);

/**
 * uploadBuffer(buf, objectKey) → public https URL
 *   objectKey: "slices/<jobId>/0001.png"
 */
async function uploadBuffer(buf, objectKey, contentType = "image/png") {
  const file = bucket.file(objectKey);

  await file.save(buf, {
    contentType,
    resumable: false,
    public    : true,     // makes it world-readable
  });

  // public URL style for Firebase/GCS buckets
  return `https://storage.googleapis.com/${bucketName}/${objectKey}`;
}

module.exports = { uploadBuffer };