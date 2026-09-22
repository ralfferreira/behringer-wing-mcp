/**
 * WING address helpers.
 *
 * The WING OSC address space mirrors the console's internal node tree.
 * Numbers are not zero-padded (unlike the X32): /ch/1, /bus/3, etc.
 *
 * Strip counts used by the typed helpers:
 *   ch:   1-40   input channels (the remaining "48 channels" are aux)
 *   aux:  1-8    aux input channels
 *   bus:  1-16   buses
 *   main: 1-4    mains
 *   mtx:  1-8    matrices
 *   dca:  1-16   DCAs
 *
 * Frequently used leaves under a strip:
 *   /fdr    fader level in dB (float; -144 = -inf)
 *   /mute   1 = muted, 0 = unmuted
 *   /pan    -100..+100
 *   /name   stored scribble name
 *   /$name  surface display name (what the operator sees; may differ from /name)
 *   /col    scribble color index
 *
 * Verify raw leaves against the Remote Protocols document for your firmware.
 */
import { OscClient, OscMessage } from "./osc.js";

export type StripKind = "ch" | "aux" | "bus" | "main" | "mtx" | "dca";
export type BusSendSourceKind = "ch" | "aux" | "bus";
export type ProcBlock = "eq" | "gate" | "dyn" | "flt";
export type EqBand = "low" | "1" | "2" | "3" | "4" | "high";

export const STRIP_KINDS: StripKind[] = ["ch", "aux", "bus", "main", "mtx", "dca"];

const STRIP_LIMITS: Record<StripKind, number> = {
  ch: 40,
  aux: 8,
  bus: 16,
  main: 4,
  mtx: 8,
  dca: 16,
};

/** Default plugin models whose italic OSC leaves the typed tools understand. */
export const DEFAULT_MDL = {
  eq: "STD",
  gate: "GATE",
  dyn: "COMP",
  flt: "TILT",
} as const;

const PROC_KINDS: Record<ProcBlock, ReadonlySet<StripKind>> = {
  eq: new Set(["ch", "aux", "bus", "main", "mtx"]),
  gate: new Set(["ch"]),
  dyn: new Set(["ch", "aux", "bus", "main", "mtx"]),
  flt: new Set(["ch"]),
};

const EQ_BAND_LEAVES: Record<EqBand, { gain: string; freq: string; q: string; type?: string }> = {
  low: { gain: "lg", freq: "lf", q: "lq", type: "leq" },
  "1": { gain: "1g", freq: "1f", q: "1q" },
  "2": { gain: "2g", freq: "2f", q: "2q" },
  "3": { gain: "3g", freq: "3f", q: "3q" },
  "4": { gain: "4g", freq: "4f", q: "4q" },
  high: { gain: "hg", freq: "hf", q: "hq", type: "heq" },
};

const DYN_PARAM_MDLS = new Set(["COMP", "EXP"]);

export function eqBandLeaf(band: EqBand, leaf: "gain" | "freq" | "q" | "type"): string {
  const map = EQ_BAND_LEAVES[band];
  if (leaf === "type") {
    if (!map.type) throw new Error(`EQ band ${band} has no type leaf`);
    return map.type;
  }
  return map[leaf];
}

export function assertProcKind(block: ProcBlock, kind: StripKind): void {
  if (!PROC_KINDS[block].has(kind)) {
    throw new Error(`${block} is not available on ${kind}; supported kinds: ${[...PROC_KINDS[block]].join(", ")}`);
  }
}

export function nonDefaultMdlError(block: ProcBlock, mdl: string, expected: string): Error {
  return new Error(
    `${block} model is ${mdl}, not ${expected}. Typed ${block} parameter writes target the default model only. Use osc_get/osc_set for this plugin.`
  );
}

function clampRange(value: number, min: number, max: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite, got ${value}`);
  return Math.max(min, Math.min(max, value));
}

/** Leaves that exist on every typed strip kind used by list/status helpers. */
const STATUS_LEAVES: Record<StripKind, ReadonlyArray<"fdr" | "mute" | "pan">> = {
  ch: ["fdr", "mute", "pan"],
  aux: ["fdr", "mute", "pan"],
  bus: ["fdr", "mute", "pan"],
  main: ["fdr", "mute", "pan"],
  mtx: ["fdr", "mute", "pan"],
  // DCA has no pan node; asking for it waits the full OSC timeout.
  dca: ["fdr", "mute"],
};

/** Strips that expose a surface display name at `/$name`. DCA does not. */
const HAS_SURFACE_NAME = new Set<StripKind>(["ch", "aux", "bus", "main", "mtx"]);

const BUS_SEND_SOURCE_KINDS = new Set<StripKind>(["ch", "aux", "bus"]);

export interface StripRef {
  kind: StripKind;
  index: number;
}

export interface StripSummary extends StripRef {
  id: string;
  /** Surface display name: prefers `/$name` when set, else `/name`. */
  name: string;
  /** Stored `/name` when it differs from the surface display name. */
  storedName?: string;
  fader?: string;
  mute?: string;
  pan?: string;
  error?: string;
}

export interface StripNameMatch extends StripSummary {
  score: number;
}

function assertStripIndex(kind: StripKind, index: number): void {
  const max = STRIP_LIMITS[kind];
  if (!Number.isInteger(index) || index < 1 || index > max) {
    throw new Error(`${kind} index must be 1-${max}, got ${index}`);
  }
}

export function stripId(kind: StripKind, index: number): string {
  assertStripIndex(kind, index);
  return `${kind}/${index}`;
}

export function stripAddress(kind: StripKind, index: number, leaf: string): string {
  assertStripIndex(kind, index);
  return `/${kind}/${index}/${leaf.replace(/^\//, "")}`;
}

export function busSendAddress(sourceKind: BusSendSourceKind, sourceIndex: number, busIndex: number, leaf: "lvl" | "on" = "lvl"): string {
  if (!BUS_SEND_SOURCE_KINDS.has(sourceKind)) {
    throw new Error(`bus send source kind must be ch, aux, or bus, got ${sourceKind}`);
  }
  assertStripIndex(sourceKind, sourceIndex);
  assertStripIndex("bus", busIndex);
  return stripAddress(sourceKind, sourceIndex, `send/${busIndex}/${leaf}`);
}

export function assertFxSlot(slot: number): void {
  if (!Number.isInteger(slot) || slot < 1 || slot > 16) {
    throw new Error(`FX slot must be 1-16, got ${slot}`);
  }
}

export function fxAddress(slot: number, leaf: string): string {
  assertFxSlot(slot);
  return `/fx/${slot}/${leaf.replace(/^\//, "")}`;
}

export type InsertPosition = "pre" | "post";

const INSERT_KINDS = new Set<StripKind>(["ch", "aux", "bus", "main", "mtx"]);
const POST_INSERT_KINDS = new Set<StripKind>(["ch", "bus", "main", "mtx"]);

/** Models that require premium FX slots 1-8 (external memory). */
const PREMIUM_FX_MDLS = new Set([
  "HALL",
  "ROOM",
  "CHAMBER",
  "PLATE",
  "CONCERT",
  "AMBI",
  "V-ROOM",
  "V-REV",
  "V-PLATE",
  "GATED",
  "REVERSE",
  "DEL/REV",
  "SHIMMER",
  "SPRING",
  "DIMCRS",
  "CHORUS",
  "FLANGER",
  "ST-DL",
  "TAP-DL",
  "TAPE-DL",
  "OILCAN",
  "BBD-DL",
  "PITCH",
  "D-PITCH",
  "VSS3",
  "BPLATE",
]);

export function assertFxModelForSlot(slot: number, mdl: string): void {
  assertFxSlot(slot);
  const normalized = mdl.trim().toUpperCase();
  if (slot >= 9 && PREMIUM_FX_MDLS.has(normalized)) {
    throw new Error(`FX model ${normalized} requires a premium slot 1-8, got slot ${slot}`);
  }
}

export function insertAddress(kind: StripKind, index: number, position: InsertPosition, leaf: string): string {
  if (!INSERT_KINDS.has(kind)) {
    throw new Error(`insert is not available on ${kind}`);
  }
  if (position === "post" && !POST_INSERT_KINDS.has(kind)) {
    throw new Error(`post insert is not available on ${kind}`);
  }
  assertStripIndex(kind, index);
  const node = position === "pre" ? "preins" : "postins";
  return stripAddress(kind, index, `${node}/${leaf}`);
}

export function formatFxIns(slot: number | "NONE" | null | undefined): string {
  if (slot === undefined || slot === null || slot === "NONE") return "NONE";
  assertFxSlot(slot);
  return `FX${slot}`;
}

export function clampDb(db: number): number {
  if (!Number.isFinite(db)) {
    throw new Error(`dB value must be finite, got ${db}`);
  }
  return Math.max(-144, Math.min(10, db));
}

export function argSummary(msg: OscMessage): string {
  if (msg.args.length === 0) return "(no value returned)";
  return msg.args.map((a) => (a.type === "f" ? Number((a.value as number).toFixed(2)) : a.value)).join(", ");
}

function firstNumericArg(msg: OscMessage, address: string): number {
  const arg = msg.args[0];
  const value = typeof arg?.value === "number" ? arg.value : Number(arg?.value);
  if (!Number.isFinite(value)) {
    throw new Error(`Expected numeric value from ${address}, got ${argSummary(msg)}`);
  }
  return value;
}

export const OSC_RONLY_ADDRESS = "/$ctl/OSC/ronly";
export const OSC_RONLY_ERROR =
  "Cannot change the mixer: OSC Remote Lock is ON. On the WING screen open Setup → Remote → Remote Lock and turn OSC lock OFF, then try again.";

export const WRITE_DID_NOT_STICK_HINT =
  "The mixer did not apply the change. On the WING screen open Setup → Remote → Remote Lock and turn OSC lock OFF, then try again.";

/** Prefer the int32 in a WING `,sfi` reply; fall back to the first coercible arg. */
export function oscIntFlag(msg: OscMessage, address: string): number {
  const intArg = msg.args.find((a) => a.type === "i");
  if (typeof intArg?.value === "number" && Number.isInteger(intArg.value)) {
    return intArg.value;
  }
  return firstNumericArg(msg, address);
}

/** dB from a WING `,sff` fader reply (last float is the dB value). */
export function faderDbFromReply(msg: OscMessage, address: string): number {
  const floats = msg.args.filter((a) => a.type === "f" && typeof a.value === "number");
  if (floats.length > 0) {
    return floats[floats.length - 1]!.value as number;
  }
  return firstNumericArg(msg, address);
}

export function formatFaderDb(db: number): string {
  if (db <= -143.5) return "-oo dB";
  return `${Number(db.toFixed(1))} dB`;
}

export function formatMuteState(muted: boolean): string {
  return muted ? "muted" : "unmuted";
}

function assertWriteStuck(ok: boolean): void {
  if (!ok) {
    throw new Error(WRITE_DID_NOT_STICK_HINT);
  }
}

export function normalizeStripName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function matchScore(normalizedQuery: string, name: string): number | undefined {
  const n = normalizeStripName(name);
  if (!n) return undefined;
  if (n === normalizedQuery) return 100;
  if (n.startsWith(normalizedQuery)) return 90;
  if (n.includes(normalizedQuery)) return 80;

  const queryTokens = normalizedQuery.split(" ");
  const nameTokens = new Set(n.split(" "));
  if (queryTokens.every((token) => nameTokens.has(token))) return 70;
  if (queryTokens.every((token) => n.includes(token))) return 60;
  return undefined;
}

function bestNameScore(normalizedQuery: string, ...names: Array<string | undefined>): number | undefined {
  let best: number | undefined;
  for (const name of names) {
    if (!name) continue;
    const score = matchScore(normalizedQuery, name);
    if (score !== undefined && (best === undefined || score > best)) {
      best = score;
    }
  }
  return best;
}

/** Pick the scribble the operator sees on the surface (`/$name`) when present. */
export function surfaceName(storedName: string, displayName: string): { name: string; storedName?: string } {
  const stored = storedName.trim();
  const display = displayName.trim();
  if (display && display !== "(no value returned)") {
    return display === stored ? { name: display } : { name: display, storedName: stored || undefined };
  }
  return { name: stored };
}

export function findStripNameMatches(query: string, strips: StripSummary[], maxResults = 10): StripNameMatch[] {
  const normalizedQuery = normalizeStripName(query);
  if (!normalizedQuery) {
    throw new Error("query must contain at least one searchable character");
  }

  return strips
    .map((strip) => {
      const score = bestNameScore(normalizedQuery, strip.name, strip.storedName);
      return score === undefined ? undefined : { ...strip, score };
    })
    .filter((strip): strip is StripNameMatch => strip !== undefined)
    .sort((a, b) => b.score - a.score || STRIP_KINDS.indexOf(a.kind) - STRIP_KINDS.indexOf(b.kind) || a.index - b.index)
    .slice(0, maxResults);
}

export function stripRefs(kinds: StripKind[] = STRIP_KINDS): StripRef[] {
  const refs: StripRef[] = [];
  for (const kind of kinds) {
    const max = STRIP_LIMITS[kind];
    for (let index = 1; index <= max; index += 1) {
      refs.push({ kind, index });
    }
  }
  return refs;
}

export class Wing {
  constructor(readonly osc: OscClient) {}

  /**
   * Fail before writes when the console has OSC Remote Lock / read-only enabled.
   * Live SETs are otherwise silently ignored while GETs still succeed.
   */
  async assertOscWritable(): Promise<void> {
    const msg = await this.osc.get(OSC_RONLY_ADDRESS);
    if (oscIntFlag(msg, OSC_RONLY_ADDRESS) === 1) {
      throw new Error(OSC_RONLY_ERROR);
    }
  }

  async readStripNames(kind: StripKind, index: number): Promise<{ name: string; storedName?: string }> {
    const stored = argSummary(await this.osc.get(stripAddress(kind, index, "name")));
    if (!HAS_SURFACE_NAME.has(kind)) {
      return surfaceName(stored, "");
    }
    let display = "";
    try {
      display = argSummary(await this.osc.get(stripAddress(kind, index, "$name")));
    } catch {
      // Rare firmware gaps: fall back to /name.
    }
    return surfaceName(stored, display);
  }

  /** Fader in dB. Use -144 (or lower) for -oo. */
  async setFader(kind: StripKind, index: number, db: number): Promise<string> {
    const address = stripAddress(kind, index, "fdr");
    const clamped = clampDb(db);
    const msg = await this.osc.setAndConfirm(address, clamped, "f");
    const confirmed = faderDbFromReply(msg, address);
    const bothInf = clamped <= -143.5 && confirmed <= -143.5;
    assertWriteStuck(bothInf || Math.abs(confirmed - clamped) <= 0.75);
    return formatFaderDb(confirmed);
  }

  async adjustFader(kind: StripKind, index: number, deltaDb: number): Promise<{ previous: number; target: number; confirmed: string }> {
    const address = stripAddress(kind, index, "fdr");
    const current = faderDbFromReply(await this.osc.get(address), address);
    const target = clampDb(current + deltaDb);
    const msg = await this.osc.setAndConfirm(address, target, "f");
    const confirmed = faderDbFromReply(msg, address);
    const bothInf = target <= -143.5 && confirmed <= -143.5;
    assertWriteStuck(bothInf || Math.abs(confirmed - target) <= 0.75);
    return { previous: current, target, confirmed: formatFaderDb(confirmed) };
  }

  async setMute(kind: StripKind, index: number, muted: boolean): Promise<string> {
    const address = stripAddress(kind, index, "mute");
    const target = muted ? 1 : 0;
    const msg = await this.osc.setAndConfirm(address, target, "i");
    assertWriteStuck(oscIntFlag(msg, address) === target);
    return formatMuteState(muted);
  }

  async setPan(kind: StripKind, index: number, pan: number): Promise<string> {
    const clamped = Math.max(-100, Math.min(100, pan));
    const msg = await this.osc.setAndConfirm(stripAddress(kind, index, "pan"), clamped, "f");
    return argSummary(msg);
  }

  async setName(kind: StripKind, index: number, name: string): Promise<string> {
    const msg = await this.osc.setAndConfirm(stripAddress(kind, index, "name"), name, "s");
    return argSummary(msg);
  }

  async setBusSend(
    sourceKind: BusSendSourceKind,
    sourceIndex: number,
    busIndex: number,
    db: number,
    enabled?: boolean
  ): Promise<{ level: string; enabled?: string }> {
    const levelMsg = await this.osc.setAndConfirm(busSendAddress(sourceKind, sourceIndex, busIndex, "lvl"), clampDb(db), "f");
    const result: { level: string; enabled?: string } = { level: argSummary(levelMsg) };
    if (enabled !== undefined) {
      const enabledMsg = await this.osc.setAndConfirm(busSendAddress(sourceKind, sourceIndex, busIndex, "on"), enabled ? 1 : 0, "i");
      result.enabled = argSummary(enabledMsg);
    }
    return result;
  }

  async listStrips(kinds: StripKind[] = STRIP_KINDS, includeStatus = false): Promise<StripSummary[]> {
    const out: StripSummary[] = [];
    for (const { kind, index } of stripRefs(kinds)) {
      const summary: StripSummary = { kind, index, id: stripId(kind, index), name: "" };
      try {
        const names = await this.readStripNames(kind, index);
        summary.name = names.name;
        if (names.storedName) summary.storedName = names.storedName;
        if (includeStatus) {
          for (const leaf of STATUS_LEAVES[kind]) {
            summary[leaf === "fdr" ? "fader" : leaf] = argSummary(await this.osc.get(stripAddress(kind, index, leaf)));
          }
        }
      } catch (err) {
        summary.error = (err as Error).message;
      }
      out.push(summary);
    }
    return out;
  }

  async findStripsByName(query: string, kinds: StripKind[] = STRIP_KINDS, maxResults = 10): Promise<StripNameMatch[]> {
    return findStripNameMatches(query, await this.listStrips(kinds), maxResults);
  }

  /** Read a small status snapshot of one strip. */
  async stripStatus(kind: StripKind, index: number): Promise<Record<string, string>> {
    const leaves = HAS_SURFACE_NAME.has(kind)
      ? (["name", "$name", ...STATUS_LEAVES[kind]] as const)
      : (["name", ...STATUS_LEAVES[kind]] as const);
    const out: Record<string, string> = {};
    for (const leaf of leaves) {
      try {
        const msg = await this.osc.get(stripAddress(kind, index, leaf));
        out[leaf] = argSummary(msg);
      } catch (err) {
        out[leaf] = `error: ${(err as Error).message}`;
      }
    }
    return out;
  }

  private async readLeaf(kind: StripKind, index: number, leaf: string): Promise<string> {
    return argSummary(await this.osc.get(stripAddress(kind, index, leaf)));
  }

  private async readFloatLeaf(kind: StripKind, index: number, leaf: string): Promise<number> {
    const address = stripAddress(kind, index, leaf);
    return faderDbFromReply(await this.osc.get(address), address);
  }

  private async readMdl(kind: StripKind, index: number, block: ProcBlock): Promise<string> {
    return (await this.readLeaf(kind, index, `${block}/mdl`)).trim();
  }

  private async writeIntFlag(kind: StripKind, index: number, leaf: string, on: boolean): Promise<string> {
    const address = stripAddress(kind, index, leaf);
    const target = on ? 1 : 0;
    const msg = await this.osc.setAndConfirm(address, target, "i");
    assertWriteStuck(oscIntFlag(msg, address) === target);
    return argSummary(msg);
  }

  private async writeFloat(kind: StripKind, index: number, leaf: string, value: number): Promise<string> {
    const address = stripAddress(kind, index, leaf);
    const msg = await this.osc.setAndConfirm(address, value, "f");
    return argSummary(msg);
  }

  private async writeString(kind: StripKind, index: number, leaf: string, value: string): Promise<string> {
    const address = stripAddress(kind, index, leaf);
    const msg = await this.osc.setAndConfirm(address, value, "s");
    return argSummary(msg);
  }

  async getEqStatus(kind: StripKind, index: number): Promise<Record<string, unknown>> {
    assertProcKind("eq", kind);
    assertStripIndex(kind, index);
    const mdl = await this.readMdl(kind, index, "eq");
    const out: Record<string, unknown> = {
      on: oscIntFlag(await this.osc.get(stripAddress(kind, index, "eq/on")), stripAddress(kind, index, "eq/on")),
      mdl,
      mix: await this.readFloatLeaf(kind, index, "eq/mix"),
    };
    if (mdl !== DEFAULT_MDL.eq) {
      out.note = `non-STD model; band details omitted. Use osc_get for ${mdl} leaves.`;
      return out;
    }
    const bands: Record<string, Record<string, string | number>> = {};
    for (const band of Object.keys(EQ_BAND_LEAVES) as EqBand[]) {
      const leaves = EQ_BAND_LEAVES[band];
      bands[band] = {
        gain_db: await this.readFloatLeaf(kind, index, `eq/${leaves.gain}`),
        freq_hz: await this.readFloatLeaf(kind, index, `eq/${leaves.freq}`),
        q: await this.readFloatLeaf(kind, index, `eq/${leaves.q}`),
      };
      if (leaves.type) {
        bands[band].type = await this.readLeaf(kind, index, `eq/${leaves.type}`);
      }
    }
    out.bands = bands;
    return out;
  }

  async getGateStatus(kind: StripKind, index: number): Promise<Record<string, unknown>> {
    assertProcKind("gate", kind);
    assertStripIndex(kind, index);
    const mdl = await this.readMdl(kind, index, "gate");
    const out: Record<string, unknown> = {
      on: oscIntFlag(await this.osc.get(stripAddress(kind, index, "gate/on")), stripAddress(kind, index, "gate/on")),
      mdl,
    };
    if (mdl !== DEFAULT_MDL.gate) {
      out.note = `non-GATE model; use osc_get for ${mdl} leaves.`;
      return out;
    }
    out.thr_db = await this.readFloatLeaf(kind, index, "gate/thr");
    out.range_db = await this.readFloatLeaf(kind, index, "gate/range");
    out.att_ms = await this.readFloatLeaf(kind, index, "gate/att");
    out.hld_ms = await this.readFloatLeaf(kind, index, "gate/hld");
    out.rel_ms = await this.readFloatLeaf(kind, index, "gate/rel");
    out.acc = await this.readFloatLeaf(kind, index, "gate/acc");
    out.ratio = await this.readLeaf(kind, index, "gate/ratio");
    return out;
  }

  async getDynStatus(kind: StripKind, index: number): Promise<Record<string, unknown>> {
    assertProcKind("dyn", kind);
    assertStripIndex(kind, index);
    const onAddr = stripAddress(kind, index, "dyn/on");
    const out: Record<string, unknown> = {
      on: oscIntFlag(await this.osc.get(onAddr), onAddr),
    };
    let mdl = "";
    try {
      mdl = await this.readMdl(kind, index, "dyn");
      out.mdl = mdl;
    } catch (err) {
      out.mdl_error = (err as Error).message;
    }
    if (mdl && !DYN_PARAM_MDLS.has(mdl) && mdl !== DEFAULT_MDL.dyn) {
      out.note = `non-COMP/EXP model; use osc_get for ${mdl} leaves.`;
      return out;
    }
    try {
      out.thr_db = await this.readFloatLeaf(kind, index, "dyn/thr");
      out.ratio = await this.readLeaf(kind, index, "dyn/ratio");
      out.gain_db = await this.readFloatLeaf(kind, index, "dyn/gain");
      out.mix = await this.readFloatLeaf(kind, index, "dyn/mix");
      out.auto = oscIntFlag(await this.osc.get(stripAddress(kind, index, "dyn/auto")), stripAddress(kind, index, "dyn/auto"));
    } catch (err) {
      out.params_error = (err as Error).message;
    }
    return out;
  }

  async getFltStatus(kind: StripKind, index: number): Promise<Record<string, unknown>> {
    assertProcKind("flt", kind);
    assertStripIndex(kind, index);
    const mdl = await this.readMdl(kind, index, "flt");
    const out: Record<string, unknown> = {
      mdl,
      lc: oscIntFlag(await this.osc.get(stripAddress(kind, index, "flt/lc")), stripAddress(kind, index, "flt/lc")),
      lcf_hz: await this.readFloatLeaf(kind, index, "flt/lcf"),
      hc: oscIntFlag(await this.osc.get(stripAddress(kind, index, "flt/hc")), stripAddress(kind, index, "flt/hc")),
      hcf_hz: await this.readFloatLeaf(kind, index, "flt/hcf"),
      tf: oscIntFlag(await this.osc.get(stripAddress(kind, index, "flt/tf")), stripAddress(kind, index, "flt/tf")),
    };
    if (mdl === DEFAULT_MDL.flt) {
      out.tilt_db = await this.readFloatLeaf(kind, index, "flt/tilt");
    } else {
      out.note = `non-TILT model; use osc_get for ${mdl} tool leaves.`;
    }
    return out;
  }

  async setEq(
    kind: StripKind,
    index: number,
    opts: { on?: boolean; mix?: number; band?: EqBand; gain_db?: number; freq_hz?: number; q?: number }
  ): Promise<Record<string, string>> {
    assertProcKind("eq", kind);
    assertStripIndex(kind, index);
    const out: Record<string, string> = {};
    if (opts.on !== undefined) out.on = await this.writeIntFlag(kind, index, "eq/on", opts.on);
    if (opts.mix !== undefined) {
      out.mix = await this.writeFloat(kind, index, "eq/mix", clampRange(opts.mix, 0, 125, "eq mix"));
    }
    const needsBand = opts.band !== undefined || opts.gain_db !== undefined || opts.freq_hz !== undefined || opts.q !== undefined;
    if (needsBand) {
      if (opts.band === undefined) throw new Error("set_eq band writes require band (low|1|2|3|4|high)");
      const mdl = await this.readMdl(kind, index, "eq");
      if (mdl !== DEFAULT_MDL.eq) throw nonDefaultMdlError("eq", mdl, DEFAULT_MDL.eq);
      const leaves = EQ_BAND_LEAVES[opts.band];
      if (opts.gain_db !== undefined) {
        out.gain = await this.writeFloat(kind, index, `eq/${leaves.gain}`, clampRange(opts.gain_db, -15, 15, "eq gain"));
      }
      if (opts.freq_hz !== undefined) {
        const min = opts.band === "low" ? 20 : opts.band === "high" ? 50 : 20;
        const max = opts.band === "low" ? 2000 : 20000;
        out.freq = await this.writeFloat(kind, index, `eq/${leaves.freq}`, clampRange(opts.freq_hz, min, max, "eq freq"));
      }
      if (opts.q !== undefined) {
        out.q = await this.writeFloat(kind, index, `eq/${leaves.q}`, clampRange(opts.q, 0.44, 10, "eq q"));
      }
    }
    if (Object.keys(out).length === 0) throw new Error("set_eq requires at least one of on, mix, or band parameters");
    return out;
  }

  async setGate(
    kind: StripKind,
    index: number,
    opts: { on?: boolean; thr_db?: number; range_db?: number; att_ms?: number; hld_ms?: number; rel_ms?: number }
  ): Promise<Record<string, string>> {
    assertProcKind("gate", kind);
    assertStripIndex(kind, index);
    const out: Record<string, string> = {};
    if (opts.on !== undefined) out.on = await this.writeIntFlag(kind, index, "gate/on", opts.on);
    const needsParams =
      opts.thr_db !== undefined || opts.range_db !== undefined || opts.att_ms !== undefined || opts.hld_ms !== undefined || opts.rel_ms !== undefined;
    if (needsParams) {
      const mdl = await this.readMdl(kind, index, "gate");
      if (mdl !== DEFAULT_MDL.gate) throw nonDefaultMdlError("gate", mdl, DEFAULT_MDL.gate);
      if (opts.thr_db !== undefined) {
        out.thr = await this.writeFloat(kind, index, "gate/thr", clampRange(opts.thr_db, -80, 0, "gate thr"));
      }
      if (opts.range_db !== undefined) {
        out.range = await this.writeFloat(kind, index, "gate/range", clampRange(opts.range_db, 3, 60, "gate range"));
      }
      if (opts.att_ms !== undefined) {
        out.att = await this.writeFloat(kind, index, "gate/att", clampRange(opts.att_ms, 0, 120, "gate att"));
      }
      if (opts.hld_ms !== undefined) {
        out.hld = await this.writeFloat(kind, index, "gate/hld", clampRange(opts.hld_ms, 0, 200, "gate hld"));
      }
      if (opts.rel_ms !== undefined) {
        out.rel = await this.writeFloat(kind, index, "gate/rel", clampRange(opts.rel_ms, 4, 4000, "gate rel"));
      }
    }
    if (Object.keys(out).length === 0) throw new Error("set_gate requires at least one parameter");
    return out;
  }

  async setDyn(
    kind: StripKind,
    index: number,
    opts: { on?: boolean; thr_db?: number; ratio?: string; gain_db?: number; mix?: number; auto?: boolean }
  ): Promise<Record<string, string>> {
    assertProcKind("dyn", kind);
    assertStripIndex(kind, index);
    const out: Record<string, string> = {};
    if (opts.on !== undefined) out.on = await this.writeIntFlag(kind, index, "dyn/on", opts.on);
    const needsParams =
      opts.thr_db !== undefined || opts.ratio !== undefined || opts.gain_db !== undefined || opts.mix !== undefined || opts.auto !== undefined;
    if (needsParams) {
      const mdl = await this.readMdl(kind, index, "dyn");
      if (!DYN_PARAM_MDLS.has(mdl)) throw nonDefaultMdlError("dyn", mdl, "COMP or EXP");
      if (opts.thr_db !== undefined) {
        out.thr = await this.writeFloat(kind, index, "dyn/thr", clampRange(opts.thr_db, -60, 0, "dyn thr"));
      }
      if (opts.ratio !== undefined) out.ratio = await this.writeString(kind, index, "dyn/ratio", opts.ratio);
      if (opts.gain_db !== undefined) {
        out.gain = await this.writeFloat(kind, index, "dyn/gain", clampRange(opts.gain_db, -6, 12, "dyn gain"));
      }
      if (opts.mix !== undefined) {
        out.mix = await this.writeFloat(kind, index, "dyn/mix", clampRange(opts.mix, 0, 100, "dyn mix"));
      }
      if (opts.auto !== undefined) out.auto = await this.writeIntFlag(kind, index, "dyn/auto", opts.auto);
    }
    if (Object.keys(out).length === 0) throw new Error("set_dyn requires at least one parameter");
    return out;
  }

  async setFlt(
    kind: StripKind,
    index: number,
    opts: { lc?: boolean; lcf_hz?: number; hc?: boolean; hcf_hz?: number; tilt_db?: number }
  ): Promise<Record<string, string>> {
    assertProcKind("flt", kind);
    assertStripIndex(kind, index);
    const out: Record<string, string> = {};
    if (opts.lc !== undefined) out.lc = await this.writeIntFlag(kind, index, "flt/lc", opts.lc);
    if (opts.lcf_hz !== undefined) {
      out.lcf = await this.writeFloat(kind, index, "flt/lcf", clampRange(opts.lcf_hz, 20, 2000, "flt lcf"));
    }
    if (opts.hc !== undefined) out.hc = await this.writeIntFlag(kind, index, "flt/hc", opts.hc);
    if (opts.hcf_hz !== undefined) {
      out.hcf = await this.writeFloat(kind, index, "flt/hcf", clampRange(opts.hcf_hz, 50, 20000, "flt hcf"));
    }
    if (opts.tilt_db !== undefined) {
      const mdl = await this.readMdl(kind, index, "flt");
      if (mdl !== DEFAULT_MDL.flt) throw nonDefaultMdlError("flt", mdl, DEFAULT_MDL.flt);
      out.tilt = await this.writeFloat(kind, index, "flt/tilt", clampRange(opts.tilt_db, -6, 6, "flt tilt"));
    }
    if (Object.keys(out).length === 0) throw new Error("set_flt requires at least one parameter");
    return out;
  }

  async getFxStatus(slot: number): Promise<Record<string, unknown>> {
    assertFxSlot(slot);
    const out: Record<string, unknown> = {
      slot,
      mdl: argSummary(await this.osc.get(fxAddress(slot, "mdl"))),
      fxmix: faderDbFromReply(await this.osc.get(fxAddress(slot, "fxmix")), fxAddress(slot, "fxmix")),
    };
    for (const leaf of ["$esrc", "$emode", "$a_chn", "$a_pos"] as const) {
      try {
        out[leaf] = argSummary(await this.osc.get(fxAddress(slot, leaf)));
      } catch (err) {
        out[leaf] = `error: ${(err as Error).message}`;
      }
    }
    return out;
  }

  async setFx(
    slot: number,
    opts: { mdl?: string; fxmix?: number; param_index?: number; param_value?: number | string }
  ): Promise<Record<string, string>> {
    assertFxSlot(slot);
    const out: Record<string, string> = {};
    if (opts.mdl !== undefined) {
      assertFxModelForSlot(slot, opts.mdl);
      const msg = await this.osc.setAndConfirm(fxAddress(slot, "mdl"), opts.mdl, "s");
      out.mdl = argSummary(msg);
    }
    if (opts.fxmix !== undefined) {
      const mix = clampRange(opts.fxmix, 0, 100, "fxmix");
      const msg = await this.osc.setAndConfirm(fxAddress(slot, "fxmix"), mix, "f");
      out.fxmix = argSummary(msg);
    }
    if (opts.param_index !== undefined) {
      if (!Number.isInteger(opts.param_index) || opts.param_index < 1 || opts.param_index > 40) {
        throw new Error(`FX param_index must be 1-40, got ${opts.param_index}`);
      }
      if (opts.param_value === undefined) {
        throw new Error("set_fx param_index requires param_value");
      }
      const leaf = String(opts.param_index);
      const force = typeof opts.param_value === "string" ? "s" : Number.isInteger(opts.param_value) ? "i" : "f";
      const msg = await this.osc.setAndConfirm(fxAddress(slot, leaf), opts.param_value, force);
      out[`p${opts.param_index}`] = argSummary(msg);
    }
    if (Object.keys(out).length === 0) throw new Error("set_fx requires mdl, fxmix, or param_index");
    return out;
  }

  async setInsert(
    kind: StripKind,
    index: number,
    position: InsertPosition,
    opts: { on?: boolean; fx_slot?: number | "NONE" }
  ): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    if (opts.on !== undefined) {
      const address = insertAddress(kind, index, position, "on");
      const target = opts.on ? 1 : 0;
      const msg = await this.osc.setAndConfirm(address, target, "i");
      assertWriteStuck(oscIntFlag(msg, address) === target);
      out.on = argSummary(msg);
    }
    if (opts.fx_slot !== undefined) {
      const ins = formatFxIns(opts.fx_slot);
      const address = insertAddress(kind, index, position, "ins");
      const msg = await this.osc.setAndConfirm(address, ins, "s");
      out.ins = argSummary(msg);
    }
    if (Object.keys(out).length === 0) throw new Error("set_insert requires on and/or fx_slot");
    return out;
  }
}
