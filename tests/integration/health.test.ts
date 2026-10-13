import * as Test from "alchemy/Test/Bun";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as References from "effect/References";
import Stack from "../../alchemy.run.ts";
import { formatHealthFailure, waitForHealth } from "../health-check.ts";
import { integrationTarget } from "./config.ts";

const target = integrationTarget(process.env);
const stage = `it-${target}-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
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
const stack = beforeAll(deploy(Stack).pipe(quiet), { timeout: 300_000 });
afterAll(destroy(Stack).pipe(quiet), { timeout: 180_000 });

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
            Effect.mapError((error) => new Error(formatHealthFailure(error))),
        );
    }).pipe(quiet),
    { timeout: 75_000 },
);
