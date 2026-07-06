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

const STRIP_LIMITS: Record<StripKind, number> = {
  ch: 40,
  aux: 8,
  bus: 16,
  main: 4,
  mtx: 8,
  dca: 16,
};

export function stripAddress(kind: StripKind, index: number, leaf: string): string {
  const max = STRIP_LIMITS[kind];
  if (!Number.isInteger(index) || index < 1 || index > max) {
    throw new Error(`${kind} index must be 1-${max}, got ${index}`);
  }
  return `/${kind}/${index}/${leaf.replace(/^\//, "")}`;
}

export function argSummary(msg: OscMessage): string {
  if (msg.args.length === 0) return "(no value returned)";
  return msg.args.map((a) => (a.type === "f" ? Number((a.value as number).toFixed(2)) : a.value)).join(", ");
}

export class Wing {
  constructor(readonly osc: OscClient) {}

  /** Fader in dB. Use -144 (or lower) for -oo. */
  async setFader(kind: StripKind, index: number, db: number): Promise<string> {
    const clamped = Math.max(-144, Math.min(10, db));
    const msg = await this.osc.setAndConfirm(stripAddress(kind, index, "fdr"), clamped, "f");
    return argSummary(msg);
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
