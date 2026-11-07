// A JSON-RPC client for herdr-core, spoken over `hc connect` (stdin/stdout,
// one JSON message per line). Reconnects on its own when hc goes away.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

export class HcClient extends EventEmitter {
  constructor({ bin = "hc", name = "hc" } = {}) {
    super();
    this.bin = bin;
    this.name = name;
    this.nextId = 1;
    this.pending = new Map();
    this.proc = null;
    this.ready = null;
    this.closed = false;
    this.backoff = 500;
  }

  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const proc = spawn(this.bin, ["connect", "--json"], { stdio: ["pipe", "pipe", "pipe"] });
      this.proc = proc;
      let buf = "";
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) this.#onLine(line);
        }
      });
      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (d) => console.error(`[${this.name}] hc: ${d.trim()}`));
      proc.on("error", (err) => {
        console.error(`[${this.name}] could not start hc:`, err.message);
      });
      proc.on("exit", (code, signal) => {
        console.error(`[${this.name}] hc connect exited (${code ?? signal})`);
        this.#failAll(new Error("herdr-core connection closed"));
        this.proc = null;
        this.ready = null;
        this.emit("close");
        if (!this.closed) {
          setTimeout(() => this.start().catch(() => {}), this.backoff);
          this.backoff = Math.min(this.backoff * 2, 10000);
        }
      });
      this.#call("hello", { generation: 1 })
        .then((hello) => {
          this.backoff = 500;
          this.hello = hello;
          this.emit("open", hello);
          resolve(hello);
        })
        .catch(reject);
    });
    this.ready.catch(() => {});
    return this.ready;
  }

  async request(method, params = {}, { timeoutMs = 30000 } = {}) {
    await this.start();
    return this.#call(method, params, timeoutMs);
  }

  stop() {
    this.closed = true;
    this.proc?.kill();
  }

  #call(method, params, timeoutMs = 30000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  #onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        const err = new Error(msg.error.message || "hc error");
        err.kind = msg.error.data?.kind;
        err.data = msg.error.data;
        p.reject(err);
      } else p.resolve(msg.result);
    } else if (msg.method) {
      this.emit("notification", msg.method, msg.params);
    }
  }

  #failAll(err) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
