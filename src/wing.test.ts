import assert from "node:assert/strict";
import test from "node:test";
import type { OscClient, OscMessage } from "./osc.js";
import {
  busSendAddress,
  clampDb,
  faderDbFromReply,
  findStripNameMatches,
  formatFaderDb,
  formatMuteState,
  normalizeStripName,
  oscIntFlag,
  OSC_RONLY_ERROR,
  stripAddress,
  surfaceName,
  WRITE_DID_NOT_STICK_HINT,
  Wing,
} from "./wing.js";

test("builds WING strip addresses", () => {
  assert.equal(stripAddress("ch", 1, "fdr"), "/ch/1/fdr");
  assert.equal(stripAddress("aux", 8, "/mute"), "/aux/8/mute");
  assert.equal(stripAddress("bus", 16, "pan"), "/bus/16/pan");
  assert.equal(stripAddress("dca", 16, "name"), "/dca/16/name");
});

test("rejects out-of-range strip indexes", () => {
  assert.throws(() => stripAddress("ch", 0, "fdr"), /ch index must be 1-40/);
  assert.throws(() => stripAddress("aux", 9, "fdr"), /aux index must be 1-8/);
  assert.throws(() => stripAddress("main", 5, "fdr"), /main index must be 1-4/);
});

test("builds bus send addresses", () => {
  assert.equal(busSendAddress("ch", 12, 5), "/ch/12/send/5/lvl");
  assert.equal(busSendAddress("aux", 2, 16, "on"), "/aux/2/send/16/on");
  assert.equal(busSendAddress("bus", 3, 4), "/bus/3/send/4/lvl");
});

test("rejects invalid bus send addresses", () => {
  assert.throws(() => busSendAddress("main" as never, 1, 1), /bus send source kind must be ch, aux, or bus/);
  assert.throws(() => busSendAddress("ch", 41, 1), /ch index must be 1-40/);
  assert.throws(() => busSendAddress("ch", 1, 17), /bus index must be 1-16/);
});

test("clamps dB values to WING fader range", () => {
  assert.equal(clampDb(-200), -144);
  assert.equal(clampDb(-12.5), -12.5);
  assert.equal(clampDb(12), 10);
});

test("normalizes strip names for natural-language search", () => {
  assert.equal(normalizeStripName("  Pástor-MIC!!  "), "pastor mic");
  assert.equal(normalizeStripName("Vocal_01"), "vocal 01");
});

test("rejects empty normalized search queries", () => {
  assert.throws(() => findStripNameMatches("!!!", []), /query must contain at least one searchable character/);
});

test("finds strip names with deterministic ranking", () => {
  const matches = findStripNameMatches("pastor mic", [
    { kind: "ch", index: 11, id: "ch/11", name: "Pastor Backup" },
    { kind: "ch", index: 12, id: "ch/12", name: "Pastor Mic" },
    { kind: "bus", index: 1, id: "bus/1", name: "Pastor" },
  ]);

  assert.equal(matches[0]?.id, "ch/12");
  assert.equal(matches[0]?.score, 100);
  assert.deepEqual(
    matches.map((match) => match.id),
    ["ch/12"]
  );
});

test("returns limited partial name matches", () => {
  const matches = findStripNameMatches(
    "vocal",
    [
      { kind: "ch", index: 1, id: "ch/1", name: "Vocal 1" },
      { kind: "ch", index: 2, id: "ch/2", name: "Vocal 2" },
      { kind: "aux", index: 1, id: "aux/1", name: "Video" },
    ],
    1
  );

  assert.deepEqual(
    matches.map((match) => match.id),
    ["ch/1"]
  );
});

test("prefers surface /$name over stored /name", () => {
  assert.deepEqual(surfaceName("TECLADO L", "VS"), { name: "VS", storedName: "TECLADO L" });
  assert.deepEqual(surfaceName("VS", "VS"), { name: "VS" });
  assert.deepEqual(surfaceName("TECLADO L", ""), { name: "TECLADO L" });
});

test("matches find queries against surface or stored names", () => {
  const matches = findStripNameMatches("VS", [
    { kind: "ch", index: 17, id: "ch/17", name: "VS", storedName: "TECLADO L" },
    { kind: "ch", index: 19, id: "ch/19", name: "GUIDE", storedName: "VS" },
  ]);

  assert.deepEqual(
    matches.map((match) => match.id),
    ["ch/17", "ch/19"]
  );
  assert.equal(matches[0]?.score, 100);
  assert.equal(matches[1]?.score, 100);
});

test("reads the int32 from a WING sfi flag reply", () => {
  const msg: OscMessage = {
    address: "/$ctl/OSC/ronly",
    args: [
      { type: "s", value: "1" },
      { type: "f", value: 1 },
      { type: "i", value: 1 },
    ],
  };
  assert.equal(oscIntFlag(msg, "/$ctl/OSC/ronly"), 1);
});

test("assertOscWritable rejects when console OSC is locked", async () => {
  const osc = {
    async get() {
      return {
        address: "/$ctl/OSC/ronly",
        args: [
          { type: "s", value: "1" },
          { type: "f", value: 1 },
          { type: "i", value: 1 },
        ],
      } satisfies OscMessage;
    },
  } as unknown as OscClient;

  await assert.rejects(() => new Wing(osc).assertOscWritable(), (err: Error) => {
    assert.match(err.message, /Remote Lock is ON/);
    assert.equal(err.message, OSC_RONLY_ERROR);
    return true;
  });
});

test("assertOscWritable allows writes when ronly is clear", async () => {
  const osc = {
    async get() {
      return {
        address: "/$ctl/OSC/ronly",
        args: [
          { type: "s", value: "0" },
          { type: "f", value: 0 },
          { type: "i", value: 0 },
        ],
      } satisfies OscMessage;
    },
  } as unknown as OscClient;

  await new Wing(osc).assertOscWritable();
});

test("formats fader and mute for operators", () => {
  assert.equal(formatFaderDb(-144), "-oo dB");
  assert.equal(formatFaderDb(-7.646), "-7.6 dB");
  assert.equal(formatMuteState(true), "muted");
  assert.equal(formatMuteState(false), "unmuted");
});

test("reads dB from a WING sff fader reply", () => {
  const msg: OscMessage = {
    address: "/ch/17/fdr",
    args: [
      { type: "s", value: "-7.6" },
      { type: "f", value: 0.56 },
      { type: "f", value: -7.646 },
    ],
  };
  assert.equal(faderDbFromReply(msg, "/ch/17/fdr"), -7.646);
});

test("setMute rejects when the console ignores the write", async () => {
  const reply: OscMessage = {
    address: "/ch/1/mute",
    args: [
      { type: "s", value: "0" },
      { type: "f", value: 0 },
      { type: "i", value: 0 },
    ],
  };
  const osc = {
    async setAndConfirm() {
      return reply;
    },
  } as unknown as OscClient;

  await assert.rejects(() => new Wing(osc).setMute("ch", 1, true), (err: Error) => {
    assert.equal(err.message, WRITE_DID_NOT_STICK_HINT);
    return true;
  });
});
