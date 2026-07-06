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
 *   /fdr   fader level in dB (float; -144 = -inf)
 *   /mute  1 = muted, 0 = unmuted
 *   /pan   -100..+100
 *   /name  scribble name (string)
 *   /col   scribble color index
 *   /led   ...
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

const BUS_SEND_SOURCE_KINDS = new Set<StripKind>(["ch", "aux", "bus"]);

export interface StripRef {
  kind: StripKind;
  index: number;
}

export interface StripSummary extends StripRef {
  id: string;
  name: string;
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

export function findStripNameMatches(query: string, strips: StripSummary[], maxResults = 10): StripNameMatch[] {
  const normalizedQuery = normalizeStripName(query);
  if (!normalizedQuery) {
    throw new Error("query must contain at least one searchable character");
  }

  return strips
    .map((strip) => {
      const score = matchScore(normalizedQuery, strip.name);
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

  /** Fader in dB. Use -144 (or lower) for -oo. */
  async setFader(kind: StripKind, index: number, db: number): Promise<string> {
    const clamped = clampDb(db);
    const msg = await this.osc.setAndConfirm(stripAddress(kind, index, "fdr"), clamped, "f");
    return argSummary(msg);
  }

  async adjustFader(kind: StripKind, index: number, deltaDb: number): Promise<{ previous: number; target: number; confirmed: string }> {
    const address = stripAddress(kind, index, "fdr");
    const current = firstNumericArg(await this.osc.get(address), address);
    const target = clampDb(current + deltaDb);
    const msg = await this.osc.setAndConfirm(address, target, "f");
    return { previous: current, target, confirmed: argSummary(msg) };
  }

  async setMute(kind: StripKind, index: number, muted: boolean): Promise<string> {
    const msg = await this.osc.setAndConfirm(stripAddress(kind, index, "mute"), muted ? 1 : 0, "i");
    return argSummary(msg);
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
        summary.name = argSummary(await this.osc.get(stripAddress(kind, index, "name")));
        if (includeStatus) {
          summary.fader = argSummary(await this.osc.get(stripAddress(kind, index, "fdr")));
          summary.mute = argSummary(await this.osc.get(stripAddress(kind, index, "mute")));
          summary.pan = argSummary(await this.osc.get(stripAddress(kind, index, "pan")));
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
    const leaves = ["name", "fdr", "mute", "pan"];
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
