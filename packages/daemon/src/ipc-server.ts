import { createServer, type Server, type Socket } from "node:net";
import { platform } from "node:os";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";
import type { AgentHookPayload, HookVerdictResponse } from "../../core/src/index.ts";
import { DAEMON_UNAVAILABLE } from "./lock.ts";

/** Tool payloads can be large (whole file writes); anything past this is not a hook frame. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export type HookHandler = (payload: AgentHookPayload) => Promise<HookVerdictResponse> | HookVerdictResponse;

export interface IPCEndpoint {
  path?: string;
  port?: number;
  host?: string;
}

export class IPCServer {
  private server: Server;
  private endpoint: IPCEndpoint;
  private hookHandler: HookHandler;
  private isListening: boolean = false;

  constructor(hookHandler: HookHandler, customPathOrPort?: string | number) {
    this.hookHandler = hookHandler;

    if (typeof customPathOrPort === "number" && customPathOrPort > 0) {
      this.endpoint = { host: "127.0.0.1", port: customPathOrPort };
    } else if (typeof customPathOrPort === "string") {
      this.endpoint = { path: customPathOrPort };
    } else {
      // Default OS-specific IPC endpoint
      const isWindows = platform() === "win32";
      const id = Math.random().toString(36).slice(2, 8);
      if (isWindows) {
        this.endpoint = { path: `\\\\.\\pipe\\ctrlplane-${process.pid}-${id}` };
      } else {
        this.endpoint = { path: join("/tmp", `ctrlplane-${process.pid}-${id}.sock`) };
      }
    }

    this.server = createServer((socket: Socket) => {
      this.handleConnection(socket);
    });
  }

  private handleConnection(socket: Socket): void {
    let buffer = "";

    socket.on("data", async (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > MAX_FRAME_BYTES) {
        socket.destroy();
        return;
      }

      let delimiterIndex: number;
      while ((delimiterIndex = buffer.indexOf("\n")) !== -1) {
        const rawMessage = buffer.slice(0, delimiterIndex);
        buffer = buffer.slice(delimiterIndex + 1);
        if (!rawMessage.trim()) continue;

        try {
          const payload: AgentHookPayload = JSON.parse(rawMessage);
          const response = await this.hookHandler(payload);
          socket.write(JSON.stringify(response) + "\n");
        } catch (err) {
          // Not a verdict: the marker makes the hook run the same rules in its own process.
          const errorResponse: HookVerdictResponse = {
            decision: "ALLOW",
            exitCode: 0,
            stderrMessage: `[ctrlplane IPC error] Failed to process payload: ${String(err)}`,
            matchedRuleId: DAEMON_UNAVAILABLE,
            latencyMs: 0,
          };
          socket.write(JSON.stringify(errorResponse) + "\n");
        }
      }
    });

    socket.on("error", () => {
      socket.destroy();
    });
  }

  public async start(): Promise<IPCEndpoint> {
    return new Promise((resolve, reject) => {
      if (this.endpoint.path) {
        // Clean up socket file on Unix if it exists
        if (platform() !== "win32" && existsSync(this.endpoint.path)) {
          try {
            unlinkSync(this.endpoint.path);
          } catch {
            // Ignore
          }
        }

        this.server.listen(this.endpoint.path, () => {
          this.isListening = true;
          resolve({ path: this.endpoint.path });
        });
      } else {
        this.server.listen(this.endpoint.port ?? 0, this.endpoint.host ?? "127.0.0.1", () => {
          const addr = this.server.address();
          if (typeof addr === "object" && addr !== null) {
            this.endpoint.port = addr.port;
            this.isListening = true;
            resolve({ host: this.endpoint.host, port: this.endpoint.port });
          } else {
            reject(new Error("Failed to retrieve server address"));
          }
        });
      }

      this.server.on("error", (err) => {
        reject(err);
      });
    });
  }

  public async stop(): Promise<void> {
    if (!this.isListening) return;
    return new Promise((resolve) => {
      this.server.close(() => {
        this.isListening = false;
        if (this.endpoint.path && platform() !== "win32" && existsSync(this.endpoint.path)) {
          try {
            unlinkSync(this.endpoint.path);
          } catch {
            // Ignore
          }
        }
        resolve();
      });
    });
  }

  public getEndpoint(): IPCEndpoint {
    return { ...this.endpoint };
  }
}
