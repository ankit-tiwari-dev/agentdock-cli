#!/usr/bin/env node
import { runCli } from "./cli.ts";

runCli(process.argv.slice(2)).then((code) => {
  process.exit(code);
}).catch((err) => {
  console.error("[ctrlplane fatal]", err);
  process.exit(1);
});

