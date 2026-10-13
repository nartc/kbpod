// Loaded only in isolated offline subprocesses, never by normal discovery.
import { afterAll, beforeAll, mock, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as References from "effect/References";
import { join } from "node:path";
import { digest, type Run, writeJson } from "./files.ts";
import * as policy from "./policy.ts";

const directory = process.env.KBPOD_FIXTURE_DIRECTORY;
const scenario = process.env.KBPOD_FIXTURE_SCENARIO;
if (!directory || !scenario) throw new Error("fixture_requires_explicit_context");
const events = { deploy: 0, destroy: 0 };
writeJson(join(directory, "events.json"), events);
const account = "a".repeat(32);
const origin = "https://alchemy-state-store.fixture.workers.dev";
process.env.KBPOD_INFRA_ACCOUNT_ID = account;
process.env.KBPOD_INFRA_STATE_ORIGIN = origin;
globalThis.fetch = Object.assign(
  () => {
    throw new Error("offline_network_forbidden");
  },
  { preconnect: fetch.preconnect },
);

mock.module("alchemy/Cloudflare", () => ({ providers: () => undefined, state: () => undefined }));
mock.module(new URL("../../alchemy.run.ts", import.meta.url).pathname, () => ({
  default: Effect.void,
}));
mock.module("alchemy/Test/Bun", () => ({
  make: () => ({
    beforeAll: <A>(effect: Effect.Effect<A, unknown>) => {
      let value: A;
      beforeAll(
        async () => {
          value = await Effect.runPromise(effect);
        },
        { timeout: scenario === "unsettled" ? 20 : 1_000 },
      );
      return Effect.sync(() => value);
    },
    afterAll: (effect: Effect.Effect<unknown, unknown>) =>
      afterAll(() => Effect.runPromise(effect), { timeout: 1_000 }),
    test: (name: string, effect: Effect.Effect<unknown, unknown>) =>
      test(name, () => Effect.runPromise(effect), { timeout: 1_000 }),
    deploy: () =>
      Effect.gen(function* () {
        if ((yield* References.MinimumLogLevel) !== "None" || (yield* References.TracerEnabled))
          throw new Error("supported_controls_missing");
        yield* Effect.logError("synthetic-private-exception");
        events.deploy++;
        writeJson(join(directory, "events.json"), events);
        if (["unsettled", "deploy-timeout"].includes(scenario)) return yield* Effect.never;
        if (scenario === "setup-failure")
          return yield* Effect.fail(new Error("synthetic-private-exception"));
        return { url: "http://localhost:1337" };
      }),
    destroy: () =>
      Effect.gen(function* () {
        if ((yield* References.MinimumLogLevel) !== "None" || (yield* References.TracerEnabled))
          throw new Error("supported_controls_missing");
        yield* Effect.logError("synthetic-private-exception");
        events.destroy++;
        writeJson(join(directory, "events.json"), events);
        if (["cleanup-timeout", "recovery-cleanup-timeout"].includes(scenario))
          return yield* Effect.never;
        if (["cleanup-failure", "recovery-cleanup-failure"].includes(scenario))
          return yield* Effect.fail(new Error("synthetic-private-exception"));
      }),
  }),
}));
mock.module(new URL("./metadata.ts", import.meta.url).pathname, () => ({
  readCredentials: () => ({ accountId: account, origin }),
  Metadata: class {
    async inspectRecovery() {
      if (scenario === "recovery-inspection-failure")
        throw new policy.InfraFailure("metadata_shape", 200, {
          field: "resource.bindings",
          shape: "object",
        });
      return {
        absent: scenario === "recovery-noop",
        ownership: { created: true, local: true, resourceCount: 1 },
      };
    }
    async guardCleanup() {
      if (["guard-failure", "recovery-recheck-failure"].includes(scenario))
        throw new policy.InfraFailure("unexpected_resource");
      if (scenario === "shape-failure")
        throw new policy.InfraFailure("metadata_shape", 200, {
          field: "resource.bindings",
          shape: "object",
        });
      return {
        local: true,
        resourceCount: scenario === "setup-failure" ? 0 : 1,
        created: scenario !== "setup-failure",
      };
    }
  },
}));
mock.module(new URL("./policy.ts", import.meta.url).pathname, () => ({
  ...policy,
  budgets: {
    ...policy.budgets,
    deploy: 150,
    preflight: 150,
    health: 50,
    destroy: 50,
    cleanup: 100,
  },
  readiness: async (
    _url: string,
    _signal: AbortSignal,
    options: { record: (attempt: policy.HealthAttempt) => void },
  ) => {
    if (scenario === "health-timeout") return new Promise<never>(() => {});
    const passed = scenario !== "assertion-failure";
    const attempt = { attempt: 1, status: 200, media: "json" as const, passed };
    options.record(attempt);
    return { passed, attempts: [attempt] };
  },
}));
const id = "abcdef123456";
const run: Run = {
  id,
  mode: "local",
  stage: policy.stageFor("local", id),
  parentPid: process.ppid,
  nonceHash: "fixture",
  accountHash: digest(account),
  stateOriginHash: digest(origin),
  createdAt: Date.now(),
  source: {},
  beforeWorkers: "fixture",
  beforeStages: "fixture",
};
if (scenario.startsWith("recovery-")) {
  const { registerRecovery } = await import("./recovery-native.ts");
  registerRecovery({
    run: {
      ...run,
      recoveryFrom: "22bfea207d84",
      stage: "e2e-local-22bfea207d84",
      inspectionDeadline: Date.now() + 1_000,
    },
    directory,
  });
} else {
  const { register } = await import("./native.ts");
  register({ run, directory });
}
