import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const BLOB_THRESHOLD_BYTES = 64 * 1024; // 64 KB

export class BlobStore {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true });
    }
  }

  /**
   * Stores a large payload compressed via gzip in a content-addressable path
   * Returns sha256 hash reference
   */
  public store(content: string | Buffer): {
    sha256: string;
    originalSizeBytes: number;
    compressedSizeBytes: number;
  } {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const compressed = gzipSync(buffer);

    const filePath = join(this.baseDir, `${sha256}.gz`);
    if (!existsSync(filePath)) {
      writeFileSync(filePath, compressed);
    }

    return {
      sha256,
      originalSizeBytes: buffer.length,
      compressedSizeBytes: compressed.length,
    };
  }

  /**
   * Reads and decompresses a stored blob
   */
  public retrieve(sha256: string): string {
    const filePath = join(this.baseDir, `${sha256}.gz`);
    if (!existsSync(filePath)) {
      throw new Error(`Blob not found: ${sha256}`);
    }
    const compressed = readFileSync(filePath);
    return gunzipSync(compressed).toString("utf8");
  }

  public exists(sha256: string): boolean {
    return existsSync(join(this.baseDir, `${sha256}.gz`));
  }
}

