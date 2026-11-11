import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const BLOB_THRESHOLD_BYTES = 64 * 1024; // 64 KB

export class BlobStore {
  private baseDir: string | undefined;
  private readonly createDir: (() => string) | undefined;

  /**
   * `baseDir` is a folder path, or a function that creates a fresh folder and returns its path (an in-memory
   * store passes one that calls `mkdtempSync`). Either way the folder is made on the first write, so opening a
   * store never leaves an empty folder behind.
   */
  constructor(baseDir: string | (() => string)) {
    if (typeof baseDir === "string") this.baseDir = baseDir;
    else this.createDir = baseDir;
  }

  /** The folder to write into, created by `createDir` the first time it is needed. */
  private dirForWrite(): string {
    this.baseDir ??= (this.createDir as () => string)();
    return this.baseDir;
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

    const dir = this.dirForWrite();
    const filePath = join(dir, `${sha256}.gz`);
    if (!existsSync(filePath)) {
      mkdirSync(dir, { recursive: true });
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
    const filePath = this.baseDir === undefined ? undefined : join(this.baseDir, `${sha256}.gz`);
    if (filePath === undefined || !existsSync(filePath)) {
      throw new Error(`Blob not found: ${sha256}`);
    }
    const compressed = readFileSync(filePath);
    return gunzipSync(compressed).toString("utf8");
  }

  public exists(sha256: string): boolean {
    return this.baseDir !== undefined && existsSync(join(this.baseDir, `${sha256}.gz`));
  }
}
