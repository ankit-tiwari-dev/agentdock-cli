import { SpecManager } from "../../../intent/src/index.ts";
import { failed, ok, type CommandResult } from "./result.ts";

export function handleSpecCommand(subcommand: string, args: string[], projectPath = process.cwd()): CommandResult {
  const manager = new SpecManager(projectPath);

  if (subcommand === "new") {
    const title = args[0] || "New Feature";
    manager.init(title);
    return ok(`Created specification at ${manager.getSpecPath()}`);
  }

  if (subcommand === "approve") {
    const devName = args[0] || "developer";
    const approved = manager.approve(devName);
    return ok(`Specification approved by '${devName}' (Hash: ${approved.hash.slice(0, 12)}). Baseline locked.`);
  }

  if (subcommand === "show" || !subcommand) {
    const spec = manager.load();
    return ok(
      [
        `Title:   ${spec.title} (v${spec.version})`,
        `Status:  ${spec.status}`,
        `Hash:    ${spec.hash.slice(0, 12)}`,
        `Criteria: ${spec.acceptanceCriteria.length} items defined:`,
        ...spec.acceptanceCriteria.map((c) => `  [${c.completed ? "x" : " "}] ${c.id}: ${c.description}`),
      ].join("\n"),
    );
  }

  return failed(`Unknown spec command '${subcommand}'. Available: new, approve, show.`);
}
