import { SpecManager } from "../../../intent/src/index.ts";

export function handleSpecCommand(subcommand: string, args: string[], projectPath = process.cwd()): string {
  const manager = new SpecManager(projectPath);

  if (subcommand === "new") {
    const title = args[0] || "New Feature";
    manager.init(title);
    return `Created specification at ${manager.getSpecPath()}`;
  }

  if (subcommand === "approve") {
    const devName = args[0] || "developer";
    const approved = manager.approve(devName);
    return `Specification approved by '${devName}' (Hash: ${approved.hash.slice(0, 12)}). Baseline locked.`;
  }

  if (subcommand === "show" || !subcommand) {
    const spec = manager.load();
    return [
      `Title:   ${spec.title} (v${spec.version})`,
      `Status:  ${spec.status}`,
      `Hash:    ${spec.hash.slice(0, 12)}`,
      `Criteria: ${spec.acceptanceCriteria.length} items defined:`,
      ...spec.acceptanceCriteria.map((c) => `  [${c.completed ? "x" : " "}] ${c.id}: ${c.description}`),
    ].join("\n");
  }

  return `Unknown spec command '${subcommand}'. Available: new, approve, show.`;
}
