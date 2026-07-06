import assert from "node:assert/strict";
import test from "node:test";
import { decode, encode } from "./osc.js";

test("encodes and decodes a bare OSC GET address", () => {
  const message = decode(encode("/ch/1/fdr"));

  assert.equal(message.address, "/ch/1/fdr");
  assert.deepEqual(message.args, []);
});

test("encodes and decodes int, float, and string arguments", () => {
  const intMessage = decode(encode("/ch/1/mute", [1]));
  assert.deepEqual(intMessage.args, [{ type: "i", value: 1 }]);

  const floatMessage = decode(encode("/ch/1/fdr", [-12.5]));
  assert.equal(floatMessage.args[0]?.type, "f");
  assert.equal(floatMessage.args[0]?.value, -12.5);

  const stringMessage = decode(encode("/ch/1/name", ["Vocal"]));
  assert.deepEqual(stringMessage.args, [{ type: "s", value: "Vocal" }]);
});

test("honors forced OSC argument types", () => {
  const floatMessage = decode(encode("/ch/1/fdr", [0], "f"));
  assert.equal(floatMessage.args[0]?.type, "f");
  assert.equal(floatMessage.args[0]?.value, 0);

  const intMessage = decode(encode("/ch/1/mute", ["1"], "i"));
  assert.deepEqual(intMessage.args, [{ type: "i", value: 1 }]);
});

test("rejects invalid OSC addresses and numeric arguments", () => {
  assert.throws(() => encode("ch/1/fdr"), /must start with \//);
  assert.throws(() => encode("/ch/1/mute", ["not-a-number"], "i"), /must be numeric/);
  assert.throws(() => encode("/ch/1/mute", [1.5], "i"), /must be an integer/);
});
