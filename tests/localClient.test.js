import { test } from "node:test";
import assert from "node:assert/strict";
import { localRequest, isLocalClientAvailable } from "../misc/localClient.js";

test("localClient: reports whether a lockfile is present without throwing", () => {
    assert.equal(typeof isLocalClientAvailable(), "boolean");
});

test("localClient: an unreachable endpoint fails softly", async () => {
    const res = await localRequest("/definitely-not-a-real-endpoint");
    assert.equal(res.success, false);
});
