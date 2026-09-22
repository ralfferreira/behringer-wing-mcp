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

export const STRIP_KINDS: StripKind[] = ["ch", "aux", "bus", "main", "mtx", "dca"];

const STRIP_LIMITS: Record<StripKind, number> = {
  ch: 40,
  aux: 8,
  bus: 16,
  main: 4,
  mtx: 8,
  dca: 16,
};

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
}
