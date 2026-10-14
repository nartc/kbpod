import { expect, test } from "bun:test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { HealthCheckError } from "../health-check.ts";
import { deploymentSettlement, integrationReport } from "../integration/report.ts";

const stage = "it-cloud-012345abcdef";
const secret = "PRIVATE-DO-NOT-REPORT";
const capture = () => {
    const lines: string[] = [];
    const report = integrationReport(stage, (line) => lines.push(line));
    return { lines, report };
};

test("reports stage and real Effect success without changing its value", () => {
    const { lines, report } = capture();
    expect(Effect.runSync(Effect.succeed(42).pipe(report.observe("deploy")))).toBe(42);
    expect(lines).toEqual([`stage=${stage}\n`, "phase=deploy:started\n", "phase=deploy:passed\n"]);
});

test.each([
    ["AuthError", "auth_or_state"],
    ["StateStoreError", "state"],
    [secret, "unknown"],
])("reports only the closed category for %s", (tag, category) => {
    const { lines, report } = capture();
    // Only the public SDK tag is consulted; no guessed cloud metadata fixture.
    const error = { _tag: tag, message: secret, cause: { token: secret } };
    const exit = Effect.runSyncExit(Effect.fail(error).pipe(report.observe("deploy")));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(error);
    expect(lines).toContain(`failure=${category}\n`);
    expect(lines.join("")).not.toContain(secret);
});

test("defects and malformed getters cannot print arbitrary error text", () => {
    const { lines, report } = capture();
    const error = {
        get _tag() {
            throw new Error(secret);
        },
    };
    const exit = Effect.runSyncExit(Effect.die(error).pipe(report.observe("destroy")));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(lines).toContain("phase=destroy:failed\n");
    expect(lines).toContain("failure=unknown\n");
    expect(lines.join("")).not.toContain(secret);
});

test("interruption reports a fixed outcome", () => {
    const { lines, report } = capture();
    const exit = Effect.runSyncExit(Effect.interrupt.pipe(report.observe("health")));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(lines).toContain("phase=health:interrupted\n");
});

test("health details reuse the existing allowlisted formatter", () => {
    const { lines, report } = capture();
    const error = new HealthCheckError("http_status", { status: 503, contentType: "html" });
    error.message = secret;
    error.cause = { authorization: secret };
    Effect.runSync(report.healthFailure(error));
    Effect.runSync(report.healthFailure(new Error(secret)));
    expect(lines).toContain(
        "Health verification failed: reason=http_status status=503 contentType=html\n",
    );
    expect(lines).toContain("Health verification failed: reason=unexpected\n");
    expect(lines.join("")).not.toContain(secret);
});

test("sink defects cannot change success or the original failure", () => {
    const report = integrationReport(stage, () => {
        throw new Error(secret);
    });
    expect(Effect.runSync(Effect.succeed(42).pipe(report.observe("health")))).toBe(42);
    const error = new Error("original");
    const exit = Effect.runSyncExit(Effect.fail(error).pipe(report.observe("deploy")));
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(error);
    else throw new Error("Expected original failure");
    Effect.runSync(report.healthFailure(error));
    Effect.runSync(report.unsettled());
});

test.each(["", "dev", "it-cloud-012345abcdeg", `it-cloud-${secret}`, `${stage}\nextra`])(
    "rejects invalid stage without passing it to the sink: %s",
    (value) => {
        const lines: string[] = [];
        expect(() => integrationReport(value, (line) => lines.push(line))).toThrow(
            "Invalid integration report stage.",
        );
        expect(lines).toEqual([]);
    },
);

test.each(["success", "failure", "defect"])(
    "settled %s permits cleanup even with a broken reporter",
    (outcome) => {
        const deployment = deploymentSettlement();
        const report = integrationReport(stage, () => {
            throw new Error(secret);
        });
        const task =
            outcome === "success"
                ? Effect.void
                : outcome === "failure"
                  ? Effect.fail(new Error("original"))
                  : Effect.die("original");
        Effect.runSyncExit(task.pipe(deployment.track, report.observe("deploy")));
        let cleaned = false;
        Effect.runSync(
            deployment.cleanup(
                Effect.sync(() => {
                    cleaned = true;
                }).pipe(report.observe("destroy")),
                report.unsettled(),
            ),
        );
        expect(cleaned).toBe(true);
    },
);

test("a live unsettled Effect blocks cleanup without invoking it", async () => {
    const deployment = deploymentSettlement();
    const { lines, report } = capture();
    const fiber = Effect.runFork(Effect.never.pipe(deployment.track, report.observe("deploy")));
    let cleaned = false;
    try {
        const exit = await Effect.runPromiseExit(
            deployment.cleanup(
                Effect.sync(() => {
                    cleaned = true;
                }),
                report.unsettled(),
            ),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(cleaned).toBe(false);
        expect(lines).toContain("destroy=blocked_unsettled_deploy\n");
    } finally {
        await Effect.runPromise(Fiber.interrupt(fiber));
    }
});
