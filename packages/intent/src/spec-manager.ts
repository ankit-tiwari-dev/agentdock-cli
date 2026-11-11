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

    // Re-save with approved status in frontmatter
    const current = readFileSync(this.specFilePath, "utf8");
    const updated = current.replace(/status:\s*draft/i, "status: approved");
    writeFileSync(this.specFilePath, updated, "utf8");

    return spec;
  }
}
