import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Specification } from "../../core/src/index.ts";
import { parseSpecificationMarkdown } from "./spec-parser.ts";
import { generateSpecTemplate } from "./spec-template.ts";

export class SpecManager {
  private projectPath: string;
  private specFilePath: string;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
    this.specFilePath = join(projectPath, ".ctrlplane", "spec.md");
  }

  public getSpecPath(): string {
    return this.specFilePath;
  }

  public exists(): boolean {
    return existsSync(this.specFilePath);
  }

  public init(title?: string, overview?: string): string {
    const dir = join(this.projectPath, ".ctrlplane");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    if (!existsSync(this.specFilePath)) {
      const template = generateSpecTemplate(title, overview);
      writeFileSync(this.specFilePath, template, "utf8");
      return template;
    }
    return readFileSync(this.specFilePath, "utf8");
  }

  public load(): Specification {
    if (!existsSync(this.specFilePath)) {
      this.init();
    }

    const content = readFileSync(this.specFilePath, "utf8");
    return parseSpecificationMarkdown(content);
  }

  public approve(developerName = "developer"): Specification {
    const spec = this.load();
    spec.status = "approved";
    spec.approvedBy = developerName;
    spec.approvedAt = Date.now();

    // Record the approval with the content hash it covers, so a later edit no longer counts as approved.
    const current = readFileSync(this.specFilePath, "utf8");
    writeFileSync(
      this.specFilePath,
      withFrontmatter(current, { status: "approved", approved_hash: spec.hash }),
      "utf8",
    );
    if (this.load().status !== "approved") {
      throw new Error(`Could not record the approval in ${this.specFilePath}; check its frontmatter.`);
    }

    return spec;
  }
}

/** Sets frontmatter fields, adding a frontmatter block when the file has none. The body is left as it is. */
function withFrontmatter(markdown: string, fields: Record<string, string>): string {
  const text = markdown.charCodeAt(0) === 0xfeff ? markdown.slice(1) : markdown;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  // Same frontmatter boundary as parseSpecificationMarkdown.
  const end = text.startsWith("---") ? text.indexOf("\n---", 3) : -1;
  const head = end === -1 ? ["---"] : text.slice(0, end).split(/\r?\n/);
  const cr = end > 0 && text[end - 1] === "\r" ? "\r" : "";
  if (cr) head[head.length - 1] = head[head.length - 1].slice(0, -1);
  for (const [key, value] of Object.entries(fields)) {
    const i = head.findIndex(
      (l, n) => n > 0 && l.includes(":") && l.slice(0, l.indexOf(":")).trim().toLowerCase() === key,
    );
    if (i === -1) head.push(`${key}: ${value}`);
    else head[i] = `${key}: ${value}`;
  }
  return head.join(eol) + (end === -1 ? `${eol}---${eol}${text}` : `${cr}${text.slice(end)}`);
}
