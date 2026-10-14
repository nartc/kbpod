import { appendFileSync } from "node:fs";
import * as Test from "alchemy/Test/Bun";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as References from "effect/References";
import Stack from "../../alchemy.run.ts";
import { formatHealthFailure, waitForHealth } from "../health-check.ts";
import { integrationReportPath, integrationTarget } from "./config.ts";
import { deploymentSettlement, integrationReport } from "./report.ts";

const target = integrationTarget(process.env);
const stage = `it-${target}-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
const reportPath = integrationReportPath(process.env);
const report = integrationReport(stage, (line) => {
    if (reportPath !== undefined) appendFileSync(reportPath, line, { mode: 0o600 });
});
const deployment = deploymentSettlement();
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
    profile: "kbpod-dev",
    stage,
    dev: target === "local",
    adopt: false,
});

// Supported Effect controls, not interception. Native SDK files can still contain logs.
const quiet = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
        Effect.provideService(References.MinimumLogLevel, "None"),
        Effect.withTracerEnabled(false),
    );

console.info(`Integration target=${target} stage=${stage}`);
const stack = beforeAll(deploy(Stack).pipe(quiet, deployment.track, report.observe("deploy")), {
    timeout: 300_000,
});
afterAll(
    deployment.cleanup(destroy(Stack).pipe(quiet, report.observe("destroy")), report.unsettled()),
    { timeout: 180_000 },
);

test(
    "GET /health returns the exact shared contract",
    Effect.gen(function* () {
        const { url } = yield* stack;
        if (typeof url !== "string") {
            return yield* Effect.fail(new Error("Integration stack did not return a health URL."));
        }
        const address = yield* Effect.try({
            try: () => new URL(url),
            catch: () => new Error("Unexpected integration health URL."),
        });
        const local =
            address.protocol === "http:" && ["localhost", "127.0.0.1"].includes(address.hostname);
        if (
            (target === "local" ? !local : address.protocol !== "https:") ||
            address.username ||
            address.password ||
            address.search ||
            address.hash ||
            address.pathname !== "/"
        ) {
            return yield* Effect.fail(new Error("Unexpected integration health URL."));
        }
        yield* waitForHealth(url).pipe(
            Effect.tapError(report.healthFailure),
            Effect.mapError((error) => new Error(formatHealthFailure(error))),
        );
    }).pipe(quiet, report.observe("health")),
    { timeout: 75_000 },
);
