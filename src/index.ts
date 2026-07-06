#!/usr/bin/env node
/**
 * behringer-wing-mcp - MCP server for the Behringer WING digital console.
 *
 * Env vars:
 *   WING_HOST        (required) console IP or hostname, e.g. 192.168.7.7
 *   WING_PORT        (optional) OSC UDP port, default 2223
 *   WING_TIMEOUT_MS  (optional) request timeout, default 1500
 *   WING_READ_ONLY   (optional) true/1/yes/on disables write tools
 *
 * Design choice: on-demand get/set only, no OSC subscription. The WING allows
 * a single subscription client at a time; holding it would interfere with
 * Companion, tally apps, and other integrations sharing the console.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { OscClient } from "./osc.js";
import { Wing, StripKind, argSummary } from "./wing.js";

const VERSION = "0.1.0";

const host = process.env.WING_HOST;
if (!host) {
  console.error("WING_HOST env var is required (the console's IP address or hostname)");
  process.exit(1);
}

function readIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    console.error(`${name} must be an integer between ${min} and ${max}; got ${raw}`);
    process.exit(1);
  }

  return value;
}

function readBoolEnv(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

const osc = new OscClient({
  host,
  port: readIntEnv("WING_PORT", 2223, 1, 65535),
  timeoutMs: readIntEnv("WING_TIMEOUT_MS", 1500, 100, 60000),
});
const wing = new Wing(osc);
const readOnly = readBoolEnv("WING_READ_ONLY");

const server = new McpServer({ name: "behringer-wing-mcp", version: VERSION });

const stripKind = z
  .enum(["ch", "aux", "bus", "main", "mtx", "dca"])
  .describe("Strip type: ch (input 1-40), aux (1-8), bus (1-16), main (1-4), mtx (matrix 1-8), dca (1-16)");

function errText(err: unknown) {
  return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
}

function assertWritable() {
  if (readOnly) {
    throw new Error("WING_READ_ONLY is enabled; write tools are disabled");
  }
}

server.tool(
  "set_fader",
  "Set a fader level in dB on the WING console. Range -144 (=-inf) to +10.",
  { kind: stripKind, index: z.number().int().min(1), db: z.number().min(-144).max(10) },
  async ({ kind, index, db }) => {
    try {
      assertWritable();
      const v = await wing.setFader(kind as StripKind, index, db);
      return { content: [{ type: "text", text: `${kind}/${index} fader -> ${v} dB` }] };
    } catch (err) {
      return errText(err);
    }
  }
);

server.tool(
  "set_mute",
  "Mute or unmute a strip on the WING console.",
  { kind: stripKind, index: z.number().int().min(1), muted: z.boolean() },
  async ({ kind, index, muted }) => {
    try {
      assertWritable();
      const v = await wing.setMute(kind as StripKind, index, muted);
      return { content: [{ type: "text", text: `${kind}/${index} mute -> ${v}` }] };
    } catch (err) {
      return errText(err);
    }
  }
);

server.tool(
  "set_pan",
  "Set pan position of a strip. -100 = full left, 0 = center, +100 = full right.",
  { kind: stripKind, index: z.number().int().min(1), pan: z.number().min(-100).max(100) },
  async ({ kind, index, pan }) => {
    try {
      assertWritable();
      const v = await wing.setPan(kind as StripKind, index, pan);
      return { content: [{ type: "text", text: `${kind}/${index} pan -> ${v}` }] };
    } catch (err) {
      return errText(err);
    }
  }
);

server.tool(
  "set_name",
  "Set the scribble strip name of a channel/bus/dca.",
  { kind: stripKind, index: z.number().int().min(1), name: z.string().max(16) },
  async ({ kind, index, name }) => {
    try {
      assertWritable();
      const v = await wing.setName(kind as StripKind, index, name);
      return { content: [{ type: "text", text: `${kind}/${index} name -> ${v}` }] };
    } catch (err) {
      return errText(err);
    }
  }
);

server.tool(
  "get_strip_status",
  "Read name, fader (dB), mute, and pan of one strip.",
  { kind: stripKind, index: z.number().int().min(1) },
  async ({ kind, index }) => {
    try {
      const status = await wing.stripStatus(kind as StripKind, index);
      return { content: [{ type: "text", text: `${kind}/${index}: ${JSON.stringify(status)}` }] };
    } catch (err) {
      return errText(err);
    }
  }
);

server.tool(
  "osc_get",
  "Read any raw OSC address from the WING (for example, /ch/3/eq/on). Use this for parameters not covered by typed tools.",
  { address: z.string().startsWith("/") },
  async ({ address }) => {
    try {
      const msg = await osc.get(address);
      return { content: [{ type: "text", text: `${address} = ${argSummary(msg)}` }] };
    } catch (err) {
      return errText(err);
    }
  }
);

server.tool(
  "osc_set",
  "Write any raw OSC address on the WING. Value is sent as float/int/string based on its form; use force_type to override. CAUTION: this can change anything on a live console.",
  {
    address: z.string().startsWith("/"),
    value: z.union([z.number(), z.string()]),
    force_type: z.enum(["i", "f", "s"]).optional(),
  },
  async ({ address, value, force_type }) => {
    try {
      assertWritable();
      const msg = await osc.setAndConfirm(address, value, force_type);
      return { content: [{ type: "text", text: `${address} -> ${argSummary(msg)}` }] };
    } catch (err) {
      return errText(err);
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`behringer-wing-mcp connected. Target console: ${host}:${osc.port}${readOnly ? " (read-only)" : ""}`);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    osc.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  osc.close();
  process.exit(1);
});
