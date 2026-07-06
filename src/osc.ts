/**
 * Minimal OSC 1.0 encoder/decoder over UDP, tailored for the Behringer WING.
 *
 * WING specifics:
 * - OSC listens on UDP port 2223 by default.
 * - Sending an address with no arguments is a GET. The console replies to the
 *   sender's IP and port with the current value.
 * - Sending an address with one argument is a SET.
 *
 * Only the tags used by the first typed tools are implemented: i (int32),
 * f (float32), and s (string).
 */
import dgram from "node:dgram";

export type OscArg = number | string;

export interface OscMessage {
  address: string;
  args: { type: "i" | "f" | "s"; value: OscArg }[];
}

function pad4(len: number): number {
  return (len + 3) & ~3;
}

function writeString(str: string): Buffer {
  const raw = Buffer.from(str, "utf8");
  const buf = Buffer.alloc(pad4(raw.length + 1)); // at least one NUL
  raw.copy(buf);
  return buf;
}

function numericArg(arg: OscArg, type: "i" | "f"): number {
  const value = typeof arg === "number" ? arg : Number(arg);
  if (!Number.isFinite(value)) {
    throw new Error(`OSC ${type} argument must be numeric, got ${JSON.stringify(arg)}`);
  }
  if (type === "i" && !Number.isInteger(value)) {
    throw new Error(`OSC i argument must be an integer, got ${value}`);
  }
  return value;
}

export function encode(address: string, args: OscArg[] = [], forceType?: "i" | "f" | "s"): Buffer {
  if (!address.startsWith("/")) {
    throw new Error(`OSC address must start with /, got ${address}`);
  }

  const parts: Buffer[] = [writeString(address)];
  let tags = ",";
  const argBufs: Buffer[] = [];

  for (const arg of args) {
    const type = forceType ?? (typeof arg === "string" ? "s" : Number.isInteger(arg) ? "i" : "f");
    tags += type;
    if (type === "s") {
      argBufs.push(writeString(String(arg)));
    } else {
      const value = numericArg(arg, type);
      const b = Buffer.alloc(4);
      if (type === "i") b.writeInt32BE(value);
      else b.writeFloatBE(value);
      argBufs.push(b);
    }
  }

  parts.push(writeString(tags), ...argBufs);
  return Buffer.concat(parts);
}

function readString(buf: Buffer, offset: number): [string, number] {
  const end = buf.indexOf(0, offset);
  if (end === -1) {
    throw new Error("Invalid OSC string: missing NUL terminator");
  }
  const str = buf.toString("utf8", offset, end);
  return [str, pad4(end - offset + 1) + offset];
}

export function decode(buf: Buffer): OscMessage {
  const [address, tagOffset] = readString(buf, 0);
  const msg: OscMessage = { address, args: [] };
  if (tagOffset >= buf.length || buf[tagOffset] !== 0x2c /* ',' */) return msg;

  const [tags, argStart] = readString(buf, tagOffset);
  let offset = argStart;
  for (const tag of tags.slice(1)) {
    switch (tag) {
      case "i":
        msg.args.push({ type: "i", value: buf.readInt32BE(offset) });
        offset += 4;
        break;
      case "f":
        msg.args.push({ type: "f", value: buf.readFloatBE(offset) });
        offset += 4;
        break;
      case "s": {
        const [s, next] = readString(buf, offset);
        msg.args.push({ type: "s", value: s });
        offset = next;
        break;
      }
      default:
        // Unknown tag: stop parsing rather than misalign.
        return msg;
    }
  }
  return msg;
}

export interface OscClientOptions {
  host: string;
  port?: number;
  /** Milliseconds to wait for a reply on get() before failing. */
  timeoutMs?: number;
}

/**
 * One shared UDP socket. Replies from the WING are matched to pending
 * requests by OSC address.
 */
export class OscClient {
  private socket: dgram.Socket;
  private pending = new Map<string, { resolve: (msg: OscMessage) => void; timer: ReturnType<typeof setTimeout> }[]>();
  readonly host: string;
  readonly port: number;
  readonly timeoutMs: number;

  constructor(opts: OscClientOptions) {
    this.host = opts.host;
    this.port = opts.port ?? 2223;
    this.timeoutMs = opts.timeoutMs ?? 1500;
    this.socket = dgram.createSocket("udp4");
    this.socket.on("message", (data) => this.onMessage(data));
    this.socket.on("error", (err) => {
      // Keep the MCP server alive; individual requests will time out or fail.
      console.error(`wing-mcp OSC socket error: ${err.message}`);
    });
  }

  private onMessage(data: Buffer) {
    let msg: OscMessage;
    try {
      msg = decode(data);
    } catch {
      return;
    }
    const waiters = this.pending.get(msg.address);
    if (waiters && waiters.length > 0) {
      const { resolve, timer } = waiters.shift()!;
      clearTimeout(timer);
      if (waiters.length === 0) {
        this.pending.delete(msg.address);
      }
      resolve(msg);
    }
  }

  private send(buf: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.send(buf, this.port, this.host, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Fire-and-forget SET. */
  async set(address: string, value: OscArg, forceType?: "i" | "f" | "s"): Promise<void> {
    await this.send(encode(address, [value], forceType));
  }

  /** GET: send bare address, await the console's reply for that address. */
  get(address: string): Promise<OscMessage> {
    return new Promise((resolve, reject) => {
      const removeWaiter = (timer: ReturnType<typeof setTimeout>) => {
        const waiters = this.pending.get(address);
        if (!waiters) return;
        const idx = waiters.findIndex((w) => w.timer === timer);
        if (idx !== -1) waiters.splice(idx, 1);
        if (waiters.length === 0) this.pending.delete(address);
      };

      const timer = setTimeout(() => {
        removeWaiter(timer);
        reject(new Error(`Timeout waiting for reply to ${address} (is OSC enabled on the console? Setup > Remote > Remote Lock > OSC)`));
      }, this.timeoutMs);

      const list = this.pending.get(address) ?? [];
      list.push({ resolve, timer });
      this.pending.set(address, list);

      let packet: Buffer;
      try {
        packet = encode(address);
      } catch (err) {
        clearTimeout(timer);
        removeWaiter(timer);
        reject(err);
        return;
      }

      this.send(packet).catch((err) => {
        clearTimeout(timer);
        removeWaiter(timer);
        reject(err);
      });
    });
  }

  /** SET then read back the resulting value. */
  async setAndConfirm(address: string, value: OscArg, forceType?: "i" | "f" | "s"): Promise<OscMessage> {
    await this.set(address, value, forceType);
    return this.get(address);
  }

  close() {
    this.socket.close();
  }
}
