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
import { Wing, argSummary } from "./wing.js";
import type { BusSendSourceKind, EqBand, StripKind } from "./wing.js";

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
const busSendSourceKind = z.enum(["ch", "aux", "bus"]).describe("Source strip type for a bus send: ch, aux, or bus.");

function requestedKinds(kinds?: StripKind[]): StripKind[] | undefined {
  return kinds && kinds.length > 0 ? kinds : undefined;
}

function errText(err: unknown) {
  return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
}

async function assertWritable() {
  if (readOnly) {
    throw new Error(
      "This MCP server is in read-only mode (WING_READ_ONLY). Mute, fader, and other changes are blocked until that setting is turned off."
    );
  }
  await wing.assertOscWritable();
}

const WRITE_AFTER_FIND =
  "REQUIRED before every write when the operator names a strip: call find_strip_by_name first and use the returned kind/index. " +
  "Never reuse channel numbers from earlier in the chat. The name on the mixer surface (/$name) can differ from the stored /name " +
  "(example: surface VIOLAO may be stored as SPDS L). If several matches share the top score, ask which strip before writing.";

server.tool(
  "set_fader",
  `Set a channel/bus/DCA fader level in dB. Use -144 for silence (-oo). Range -144 to +10. ${WRITE_AFTER_FIND}`,
  { kind: stripKind, index: z.number().int().min(1), db: z.number().min(-144).max(10) },
  async ({ kind, index, db }) => {
    try {
      await assertWritable();
      const v = await wing.setFader(kind as StripKind, index, db);
      return { content: [{ type: "text", text: `${kind}/${index} fader is now ${v}` }] };
    } catch (err) {
      return errText(err);
    }
  }
);

server.tool(
  "adjust_fader",
  `Raise or lower a fader by a relative amount in dB (example: -3 lowers by 3 dB). ${WRITE_AFTER_FIND}`,
  { kind: stripKind, index: z.number().int().min(1), delta_db: z.number() },
  async ({ kind, index, delta_db }) => {
    try {
      await assertWritable();
      const result = await wing.adjustFader(kind as StripKind, index, delta_db);
      return {
        content: [
          {
            type: "text",
            text: `${kind}/${index} fader ${Number(result.previous.toFixed(1))} dB -> ${result.confirmed}`,
          },
        ],
      };
    } catch (err) {
      return errText(err);
    }
  }
);

server.tool(
  "set_mute",
  `Mute or unmute a channel, bus, main, matrix, or DCA. ${WRITE_AFTER_FIND}`,
  { kind: stripKind, index: z.number().int().min(1), muted: z.boolean() },
  async ({ kind, index, muted }) => {
    try {
      await assertWritable();
      const v = await wing.setMute(kind as StripKind, index, muted);
      return { content: [{ type: "text", text: `${kind}/${index} is now ${v}` }] };
    } catch (err) {
      return errText(err);
    }
  }
);

server.tool(
  "set_pan",
  `Set pan position of a strip. -100 = full left, 0 = center, +100 = full right. ${WRITE_AFTER_FIND}`,
  { kind: stripKind, index: z.number().int().min(1), pan: z.number().min(-100).max(100) },
  async ({ kind, index, pan }) => {
    try {
      await assertWritable();
      const v = await wing.setPan(kind as StripKind, index, pan);
      return { content: [{ type: "text", text: `${kind}/${index} pan -> ${v}` }] };
    } catch (err) {
      return errText(err);
    }
  }
);

server.tool(
  "set_name",
  `Set the stored scribble-strip /name (not the surface /$name). ${WRITE_AFTER_FIND}`,
  { kind: stripKind, index: z.number().int().min(1), name: z.string().max(16) },
  async ({ kind, index, name }) => {
    try {
      await assertWritable();
      const v = await wing.setName(kind as StripKind, index, name);
      return { content: [{ type: "text", text: `${kind}/${index} name -> ${v}` }] };
    } catch (err) {
      return errText(err);
    }
  }
);

server.tool(
  "get_strip_status",
  "Read the surface name, stored name, fader, mute, and pan for one strip.",
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
  "find_strip_by_name",
  "Find strips by the name shown on the mixer surface, and by the stored name if different. " +
    "Always use this immediately before mute/fader/pan/name writes when the operator says a name " +
    "(VS, Caixa, SPDS, Violao, Guitar, etc.). Do not trust channel numbers remembered from earlier turns. " +
    "Returns name (surface), optional storedName, kind, index, and score. " +
    "If ambiguous is true or several matches share the top score, ask the operator which strip before writing.",
  {
    query: z.string().min(1),
    kinds: z.array(stripKind).optional().describe("Optional strip kinds to search. Defaults to all kinds."),
    max_results: z.number().int().min(1).max(25).optional(),
  },
  async ({ query, kinds, max_results }) => {
    try {
      const matches = await wing.findStripsByName(query, requestedKinds(kinds as StripKind[] | undefined), max_results ?? 10);
      const topScore = matches[0]?.score;
      const ambiguous = topScore !== undefined && matches.filter((match) => match.score === topScore).length > 1;
      return { content: [{ type: "text", text: JSON.stringify({ query, ambiguous, matches }) }] };
    } catch (err) {
      return errText(err);
    }
  }
);

server.tool(
  "list_strips",
  "List strip IDs with the names shown on the mixer surface (and storedName when it differs). " +
    "Use for overview only. For a named change, still call find_strip_by_name right before writing. " +
    "Set include_status to also read fader, mute, and pan.",
  {
    kinds: z.array(stripKind).optional().describe("Optional strip kinds to list. Defaults to all kinds."),
    include_status: z.boolean().optional(),
  },
  async ({ kinds, include_status }) => {
    try {
      const strips = await wing.listStrips(requestedKinds(kinds as StripKind[] | undefined), include_status ?? false);
      return { content: [{ type: "text", text: JSON.stringify(strips) }] };
    } catch (err) {
      return errText(err);
    }
  }
);

server.tool(
  "set_bus_send",
  "Set the send level from a channel, aux, or bus source to a bus destination in dB. Optionally enable or disable the send.",
  {
    source_kind: busSendSourceKind,
    source_index: z.number().int().min(1),
    bus: z.number().int().min(1).max(16),
    db: z.number().min(-144).max(10),
    enabled: z.boolean().optional(),
  },
  async ({ source_kind, source_index, bus, db, enabled }) => {
    try {
      await assertWritable();
      const result = await wing.setBusSend(source_kind as BusSendSourceKind, source_index, bus, db, enabled);
      const enabledText = result.enabled === undefined ? "" : `, enabled -> ${result.enabled}`;
      return { content: [{ type: "text", text: `${source_kind}/${source_index} send to bus/${bus} level -> ${result.level} dB${enabledText}` }] };
    } catch (err) {
      return errText(err);
    }
  }
);

const eqBand = z.enum(["low", "1", "2", "3", "4", "high"]);

server.tool(
  "get_eq_status",
  "Read EQ on/off, model, mix, and STD band gain/freq/Q. Non-STD models return mdl only and point at osc_get.",
  { kind: stripKind, index: z.number().int().min(1) },
  async ({ kind, index }) => {
    try {
      const status = await wing.getEqStatus(kind as StripKind, index);
      return { content: [{ type: "text", text: `${kind}/${index} eq: ${JSON.stringify(status)}` }] };
    } catch (err) {
      return errText(err);
    }
  }
);

server.tool(
  "get_gate_status",
  "Read gate on/off and GATE-model threshold/envelope. Channels only. Non-GATE models return mdl and point at osc_get.",
  { kind: stripKind, index: z.number().int().min(1) },
  async ({ kind, index }) => {
    try {
      const status = await wing.getGateStatus(kind as StripKind, index);
      return { content: [{ type: "text", text: `${kind}/${index} gate: ${JSON.stringify(status)}` }] };
    } catch (err) {
      return errText(err);
    }
  }
);

server.tool(
  "get_dyn_status",
  "Read compressor on/off and COMP/EXP threshold/ratio/gain/mix/auto when available.",
  { kind: stripKind, index: z.number().int().min(1) },
  async ({ kind, index }) => {
    try {
      const status = await wing.getDynStatus(kind as StripKind, index);
      return { content: [{ type: "text", text: `${kind}/${index} dyn: ${JSON.stringify(status)}` }] };
    } catch (err) {
      return errText(err);
    }
  }
);

server.tool(
  "get_flt_status",
  "Read channel filter HPF/LPF switches and frequencies, plus TILT level when mdl is TILT. Channels only.",
  { kind: stripKind, index: z.number().int().min(1) },
  async ({ kind, index }) => {
    try {
      const status = await wing.getFltStatus(kind as StripKind, index);
      return { content: [{ type: "text", text: `${kind}/${index} flt: ${JSON.stringify(status)}` }] };
    } catch (err) {
      return errText(err);
    }
  }
);

server.tool(
  "set_eq",
  `Set EQ on/off, mix, or one STD band (gain/freq/Q). Band writes require mdl STD. ${WRITE_AFTER_FIND}`,
  {
    kind: stripKind,
    index: z.number().int().min(1),
    on: z.boolean().optional(),
    mix: z.number().optional(),
    band: eqBand.optional(),
    gain_db: z.number().optional(),
    freq_hz: z.number().optional(),
    q: z.number().optional(),
  },
  async ({ kind, index, on, mix, band, gain_db, freq_hz, q }) => {
    try {
      await assertWritable();
      const result = await wing.setEq(kind as StripKind, index, {
        on,
        mix,
        band: band as EqBand | undefined,
        gain_db,
        freq_hz,
        q,
      });
      return { content: [{ type: "text", text: `${kind}/${index} eq -> ${JSON.stringify(result)}` }] };
    } catch (err) {
      return errText(err);
    }
  }
);

server.tool(
  "set_gate",
  `Set gate on/off or GATE-model thr/range/att/hld/rel. Channels only. ${WRITE_AFTER_FIND}`,
  {
    kind: stripKind,
    index: z.number().int().min(1),
    on: z.boolean().optional(),
    thr_db: z.number().optional(),
    range_db: z.number().optional(),
    att_ms: z.number().optional(),
    hld_ms: z.number().optional(),
    rel_ms: z.number().optional(),
  },
  async ({ kind, index, on, thr_db, range_db, att_ms, hld_ms, rel_ms }) => {
    try {
      await assertWritable();
      const result = await wing.setGate(kind as StripKind, index, { on, thr_db, range_db, att_ms, hld_ms, rel_ms });
      return { content: [{ type: "text", text: `${kind}/${index} gate -> ${JSON.stringify(result)}` }] };
    } catch (err) {
      return errText(err);
    }
  }
);

server.tool(
  "set_dyn",
  `Set compressor on/off or COMP/EXP thr/ratio/gain/mix/auto. ${WRITE_AFTER_FIND}`,
  {
    kind: stripKind,
    index: z.number().int().min(1),
    on: z.boolean().optional(),
    thr_db: z.number().optional(),
    ratio: z.string().optional(),
    gain_db: z.number().optional(),
    mix: z.number().optional(),
    auto: z.boolean().optional(),
  },
  async ({ kind, index, on, thr_db, ratio, gain_db, mix, auto }) => {
    try {
      await assertWritable();
      const result = await wing.setDyn(kind as StripKind, index, { on, thr_db, ratio, gain_db, mix, auto });
      return { content: [{ type: "text", text: `${kind}/${index} dyn -> ${JSON.stringify(result)}` }] };
    } catch (err) {
      return errText(err);
    }
  }
);

server.tool(
  "set_flt",
  `Set channel HPF/LPF and TILT. tilt_db requires mdl TILT. Channels only. ${WRITE_AFTER_FIND}`,
  {
    kind: stripKind,
    index: z.number().int().min(1),
    lc: z.boolean().optional(),
    lcf_hz: z.number().optional(),
    hc: z.boolean().optional(),
    hcf_hz: z.number().optional(),
    tilt_db: z.number().optional(),
  },
  async ({ kind, index, lc, lcf_hz, hc, hcf_hz, tilt_db }) => {
    try {
      await assertWritable();
      const result = await wing.setFlt(kind as StripKind, index, { lc, lcf_hz, hc, hcf_hz, tilt_db });
      return { content: [{ type: "text", text: `${kind}/${index} flt -> ${JSON.stringify(result)}` }] };
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
      await assertWritable();
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
