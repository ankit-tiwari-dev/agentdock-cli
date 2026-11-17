export class NoTerminalError extends Error {
  constructor() {
    super("No terminal to prompt in. Pipe the key in with --stdin.");
    this.name = "NoTerminalError";
  }
}

export class PromptCancelledError extends Error {
  constructor() {
    super("Cancelled. Nothing was saved.");
    this.name = "PromptCancelledError";
  }
}

type TtyInput = NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (on: boolean) => unknown };

export interface ReadSecretOptions {
  fromStdin: boolean;
  prompt?: string;
  input?: TtyInput;
  output?: NodeJS.WritableStream;
}

async function readToEnd(input: NodeJS.ReadableStream): Promise<string> {
  let text = "";
  for await (const chunk of input) text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  return text.replace(/\r?\n$/, "");
}

/** Raw mode turns echo off, and nothing is written back per keystroke, so not even the length shows. */
function readHidden(input: TtyInput, output: NodeJS.WritableStream, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = "";
    output.write(prompt);
    input.setRawMode!(true);
    input.resume();
    const finish = (err?: Error) => {
      input.removeListener("data", onData);
      input.setRawMode!(false);
      input.pause();
      output.write("\n");
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      for (const ch of chunk.toString()) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return finish();
        if (ch === "\u0003") return finish(new PromptCancelledError());
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    input.on("data", onData);
  });
}

export async function readSecret(o: ReadSecretOptions): Promise<string> {
  const input = o.input ?? (process.stdin as TtyInput);
  if (o.fromStdin) return readToEnd(input);
  if (!input.isTTY || typeof input.setRawMode !== "function") throw new NoTerminalError();
  return readHidden(input, o.output ?? process.stderr, o.prompt ?? "Key (typing is hidden): ");
}
