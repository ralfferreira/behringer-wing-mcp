import assert from "node:assert/strict";
import test from "node:test";
import { stripAddress } from "./wing.js";

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
