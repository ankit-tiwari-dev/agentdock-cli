import { spawn } from "node:child_process";

export type KeyProvider = "claude" | "openai-compatible";
export const KEY_PROVIDERS: readonly KeyProvider[] = ["claude", "openai-compatible"];

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: NodeJS.ErrnoException;
}

/** Spawns one OS keychain tool. The key only ever travels on stdin, never in `args`. */
export type KeychainRunner = (command: string, args: readonly string[], stdin: string) => Promise<RunResult>;

export interface Keychain {
  set(provider: KeyProvider, secret: string): Promise<void>;
  get(provider: KeyProvider): Promise<string | null>;
  remove(provider: KeyProvider): Promise<boolean>;
}

export class KeychainError extends Error {
  readonly reason: "unavailable" | "failed";
  constructor(reason: "unavailable" | "failed", message: string) {
    super(message);
    this.name = "KeychainError";
    this.reason = reason;
  }
}

const SERVICE = "agentdock";

export const LINUX_KEYCHAIN_HINT =
  "Install libsecret-tools (Debian/Ubuntu) or libsecret (Fedora/Arch), with a running Secret Service such as GNOME Keyring or KWallet.";

const MISSING_TOOL: Partial<Record<NodeJS.Platform, string>> = {
  linux: LINUX_KEYCHAIN_HINT,
  darwin: "macOS security tool not found.",
  win32: "Windows PowerShell not found.",
};

/** Exit code each OS tool uses for "no such entry". */
const NOT_FOUND: Partial<Record<NodeJS.Platform, number>> = { win32: 2, darwin: 44, linux: 1 };

/** Printable ASCII without whitespace, quotes or backslash, so the macOS `security -i` line has one meaning. */
export function checkKeyText(secret: string): boolean {
  return /^[\x21\x23-\x26\x28-\x5b\x5d-\x7e]{1,4096}$/.test(secret);
}

// Windows has no CLI that takes a secret off argv (cmdkey puts it there), so the
// Credential Manager is called through P/Invoke from a script read on stdin.
const WIN_CRED_TYPE = String.raw`
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct CREDENTIAL {
  public int Flags; public int Type; public string TargetName; public string Comment;
  public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
  public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
  public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
}
[DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
static extern bool CredWrite(ref CREDENTIAL c, int flags);
[DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
static extern bool CredRead(string target, int type, int flags, out IntPtr c);
[DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
static extern bool CredDelete(string target, int type, int flags);
[DllImport("advapi32.dll")]
static extern void CredFree(IntPtr c);
public static int Write(string target, string user, byte[] blob) {
  CREDENTIAL c = new CREDENTIAL();
  c.Type = 1; c.TargetName = target; c.UserName = user; c.Persist = 2; c.CredentialBlobSize = blob.Length;
  c.CredentialBlob = Marshal.AllocHGlobal(blob.Length);
  try { Marshal.Copy(blob, 0, c.CredentialBlob, blob.Length); return CredWrite(ref c, 0) ? 0 : Marshal.GetLastWin32Error(); }
  finally { Marshal.FreeHGlobal(c.CredentialBlob); }
}
public static string Read(string target, out int error) {
  IntPtr p; error = 0;
  if (!CredRead(target, 1, 0, out p)) { error = Marshal.GetLastWin32Error(); return null; }
  try {
    CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
    byte[] b = new byte[c.CredentialBlobSize];
    Marshal.Copy(c.CredentialBlob, b, 0, b.Length);
    return System.Convert.ToBase64String(b);
  } finally { CredFree(p); }
}
public static int Delete(string target) { return CredDelete(target, 1, 0) ? 0 : Marshal.GetLastWin32Error(); }
`;

function windowsScript(
  op: "set" | "get" | "remove",
  provider: KeyProvider,
  secret: string | undefined,
  service: string,
): string {
  const target = `'${service}:${provider}'`;
  const body = {
    set: `$r = [AgentDock.Cred]::Write(${target}, '${provider}', [Convert]::FromBase64String('${Buffer.from(secret ?? "", "utf8").toString("base64")}')); if ($r -ne 0) { exit 1 }; exit 0`,
    get: `$e = 0; $v = [AgentDock.Cred]::Read(${target}, [ref]$e); if ($e -eq 1168) { exit 2 }; if ($e -ne 0) { exit 1 }; [Console]::Out.Write($v); exit 0`,
    remove: `$r = [AgentDock.Cred]::Delete(${target}); if ($r -eq 1168) { exit 2 }; if ($r -ne 0) { exit 1 }; exit 0`,
  }[op];
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -Namespace AgentDock -Name Cred -MemberDefinition @'",
    WIN_CRED_TYPE.trim(),
    "'@",
    body,
    "",
  ].join("\n");
}

export function keychainCommand(
  platform: NodeJS.Platform,
  op: "set" | "get" | "remove",
  provider: KeyProvider,
  secret?: string,
  service = SERVICE,
): { command: string; args: string[]; stdin: string } {
  if (op === "set" && (secret === undefined || !checkKeyText(secret))) {
    throw new KeychainError("failed", "The key has characters a key never has. Nothing was saved.");
  }
  if (platform === "win32") {
    // The bootstrap is fixed text; the script, and the key inside it, arrive on stdin.
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", "iex ([Console]::In.ReadToEnd())"],
      stdin: windowsScript(op, provider, secret, service),
    };
  }
  if (platform === "darwin") {
    if (op === "set") {
      return {
        command: "security",
        args: ["-i"],
        stdin: `add-generic-password -U -s ${service} -a ${provider} -l "AgentDock ${provider}" -w "${secret}"\n`,
      };
    }
    const verb = op === "get" ? "find-generic-password" : "delete-generic-password";
    return {
      command: "security",
      args: [verb, "-s", service, "-a", provider, ...(op === "get" ? ["-w"] : [])],
      stdin: "",
    };
  }
  if (op === "set") {
    return {
      command: "secret-tool",
      args: ["store", `--label=AgentDock ${provider}`, "service", service, "account", provider],
      stdin: secret ?? "",
    };
  }
  return {
    command: "secret-tool",
    args: [op === "get" ? "lookup" : "clear", "service", service, "account", provider],
    stdin: "",
  };
}

export const spawnRunner: KeychainRunner = (command, args, stdin) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", (spawnError: NodeJS.ErrnoException) => resolve({ code: null, stdout, stderr, spawnError }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });

/** `service` exists for the real-keychain test, so it never touches the entries a developer uses. */
export function createKeychain(
  o: { platform?: NodeJS.Platform; runner?: KeychainRunner; service?: string } = {},
): Keychain {
  const platform = o.platform ?? process.platform;
  const service = o.service ?? SERVICE;
  const runner = o.runner ?? spawnRunner;

  async function run(op: "set" | "get" | "remove", provider: KeyProvider, secret?: string): Promise<RunResult | null> {
    const { command, args, stdin } = keychainCommand(platform, op, provider, secret, service);
    const res = await runner(command, args, stdin);
    if (res.spawnError) {
      const hint = MISSING_TOOL[platform] ?? "No supported OS keychain was found.";
      throw new KeychainError("unavailable", hint);
    }
    if (res.code === 0) return res;
    if (op !== "set" && res.code === NOT_FOUND[platform]) return null;
    // The tool's own output is never shown: it is not ours to vouch for.
    const extra = platform === "linux" ? ` ${LINUX_KEYCHAIN_HINT}` : "";
    throw new KeychainError(
      "failed",
      `The OS keychain could not complete the request (exit code ${res.code}).${extra}`,
    );
  }

  async function get(provider: KeyProvider): Promise<string | null> {
    const res = await run("get", provider);
    if (!res) return null;
    if (platform === "win32") return Buffer.from(res.stdout.trim(), "base64").toString("utf8");
    const value = res.stdout.replace(/\r?\n$/, "");
    return value === "" ? null : value;
  }

  return {
    async set(provider, secret) {
      await run("set", provider, secret);
    },
    get,
    async remove(provider) {
      // secret-tool clear succeeds whether or not an entry existed, so look first on every OS.
      if ((await get(provider)) === null) return false;
      await run("remove", provider);
      return true;
    },
  };
}
