import assert from "node:assert/strict";
import test from "node:test";
import { busSendAddress, clampDb, findStripNameMatches, normalizeStripName, stripAddress } from "./wing.js";

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
