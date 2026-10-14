import { expect, test } from "bun:test";
import { integrationTarget } from "../integration/config.ts";

test.each(["local", "cloud"] as const)(
    "selects %s without reading credentials or importing Alchemy",
    (target) => {
        expect(integrationTarget({ KBPOD_TEST_TARGET: target, DO_NOT_TRACK: "1" })).toBe(target);
    },
);

test.each([undefined, "", "live", "dev", "prod"])(
    "requires an explicit supported target: %s",
    (target) => {
        expect(() => integrationTarget({ KBPOD_TEST_TARGET: target, DO_NOT_TRACK: "1" })).toThrow();
    },
);

test("rejects an SDK override instead of silently changing the requested target", () => {
    expect(() =>
        integrationTarget({
            KBPOD_TEST_TARGET: "cloud",
            DO_NOT_TRACK: "1",
            ALCHEMY_TEST_DEV: "1",
        }),
    ).toThrow();
});

test("requires the supported telemetry opt-out", () => {
    expect(() => integrationTarget({ KBPOD_TEST_TARGET: "local" })).toThrow();
});
