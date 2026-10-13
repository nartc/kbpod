import { describe, expect, test } from "bun:test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as References from "effect/References";
import { evidenceLimits, nativeEnvironment, quietNative } from "./infra/controls.ts";
import { digest, type Run } from "./infra/files.ts";
import { Metadata } from "./infra/metadata.ts";
import { serverState } from "./infra/state.fixture.ts";
import {
  budgets,
  generatedNames,
  InfraFailure,
  Lifecycle,
  normalizeFailure,
  readiness,
  retryDelays,
  safeFailure,
  stageFor,
  validateBindings,
  validateEnvironment,
} from "./infra/policy.ts";

const secret = "synthetic-private-value-do-not-retain";
const ok = () => Response.json({ status: "ok" });
const signal = () => new AbortController().signal;

describe("native lifecycle policy (offline)", () => {
  test("supported telemetry configuration and honest evidence limits", () => {
    const env = { DO_NOT_TRACK: "", PATH: "fixture" };
    expect(nativeEnvironment(env)).toEqual({ DO_NOT_TRACK: "1", PATH: "fixture" });
    expect(env.DO_NOT_TRACK).toBe("");
    expect(evidenceLimits.detachedDescendants).toBe("not_independently_attested");
    expect(evidenceLimits.previewExpiry).toBe("not_attested");
    expect(evidenceLimits.sdkLocalLogs).toBe("may_remain_ignored_not_inspected");
  });
  test("operation deadlines leave settling and process-stop margins", () => {
    expect(budgets.deploy).toBeLessThan(budgets.deployHook);
    expect(budgets.cleanupGuard + budgets.destroy).toBe(budgets.cleanup);
    expect(budgets.cleanup).toBeLessThan(budgets.cleanupHook);
    expect(budgets.health).toBeLessThan(budgets.healthHook);
    expect(budgets.execution + 30_000 + budgets.verification).toBe(budgets.overall);
  });
  test("fresh stage shape and explicit modes", () => {
    expect(stageFor("local", "abcdef123456")).toBe("e2e-local-abcdef123456");
    expect(stageFor("live", "abcdef123456")).toBe("e2e-live-abcdef123456");
    for (const id of ["dev", "prod", "default", "../abcdef1234", "abcdef1234567"])
      expect(() => stageFor("local", id)).toThrow();
    expect(() => validateEnvironment({ ALCHEMY_TEST_DEV: "0" })).toThrow();
    expect(() => validateEnvironment({ ALCHEMY_PROFILE: "other" })).toThrow();
    expect(() => validateEnvironment({ CLOUDFLARE_API_TOKEN: secret })).toThrow();
    expect(() => validateEnvironment({ PATH: "fixture" })).not.toThrow();
  });
  test("only five generated plain-text bindings, never values", () => {
    const bindings = generatedNames.map((name) => ({ name, type: "plain_text", text: secret }));
    expect(validateBindings(bindings)).toEqual({
      generatedPlainText: 5,
      custom: 0,
      secrets: 0,
      dataReferences: 0,
    });
    expect(JSON.stringify(validateBindings(bindings))).not.toContain(secret);
    for (const invalid of [
      [],
      [...bindings, { name: secret, type: "d1" }],
      bindings.map((b) => ({ ...b, type: "secret_text" })),
      [bindings[0], bindings[0], ...bindings.slice(2)],
    ]) {
      expect(() => validateBindings(invalid)).toThrow("unexpected_binding");
    }
  });
  test("first successful response proves contract with no readiness-only request", async () => {
    let calls = 0;
    const result = await readiness("https://owned.example", signal(), {
      fetch: async (_url, init) => {
        expect(init.redirect).toBe("error");
        expect(init.signal).toBeDefined();
        calls++;
        return ok();
      },
    });
    expect(result.passed).toBe(true);
    expect(calls).toBe(1);
  });
  test.each([404, 500, 503, 599, 200])(
    "documented transient %s uses finite delays then accepts",
    async (status) => {
      let calls = 0;
      const delays: number[] = [];
      const result = await readiness("https://owned.example", signal(), {
        fetch: async () =>
          ++calls === 1
            ? new Response(secret, { status, headers: { "content-type": "text/html" } })
            : ok(),
        sleep: async (ms) => {
          delays.push(ms);
        },
      });
      expect(result.passed).toBe(true);
      expect(calls).toBe(2);
      expect(delays).toEqual([500]);
      expect(JSON.stringify(result)).not.toContain(secret);
    },
  );
  test("six failures stop, five bounded delays; no seventh request", async () => {
    let calls = 0;
    const delays: number[] = [];
    const result = await readiness("https://owned.example", signal(), {
      fetch: async () => {
        calls++;
        return new Response(secret, { status: 503 });
      },
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    expect(result.passed).toBe(false);
    expect(calls).toBe(6);
    expect(delays).toEqual([...retryDelays]);
    expect(delays.reduce((a, b) => a + b, 0) + 6 * 10_000).toBeLessThan(budgets.health);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  test.each([400, 401, 403, 429, 302])("terminal HTTP%s does not retry", async (status) => {
    const result = await readiness("https://owned.example", signal(), {
      fetch: async () => new Response(secret, { status }),
    });
    expect(result.passed).toBe(false);
    expect(result.attempts).toHaveLength(1);
  });
  test.each(["malformed", "schema", "extra", "text", "transport", "timeout"])(
    "terminal %s does not retry or leak",
    async (kind) => {
      const result = await readiness("https://owned.example", signal(), {
        fetch: async () => {
          if (kind === "transport") throw Object.assign(new Error(secret), { code: "ENOTFOUND" });
          if (kind === "timeout") throw Object.assign(new Error(secret), { name: "TimeoutError" });
          if (kind === "malformed")
            return new Response(secret, { headers: { "content-type": "application/json" } });
          if (kind === "schema") return Response.json({ status: secret });
          if (kind === "extra") return Response.json({ status: "ok", token: secret });
          return new Response(secret, { headers: { "content-type": "text/plain" } });
        },
      });
      expect(result.passed).toBe(false);
      expect(result.attempts).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(result.attempts[0]?.diagnostic).toContain("Health verification failed:");
    },
  );
  test("phase abort propagates into a pending fetch and prevents retries", async () => {
    const controller = new AbortController();
    let received: AbortSignal | null | undefined;
    const pending = readiness("https://owned.example", controller.signal, {
      fetch: async (_url, init) => {
        received = init.signal;
        return new Promise<Response>((_resolve, reject) =>
          init.signal?.addEventListener("abort", () => reject(new Error(secret)), { once: true }),
        );
      },
    });
    await Promise.resolve();
    controller.abort();
    const result = await pending;
    expect(received?.aborted).toBe(true);
    expect(result.attempts).toHaveLength(1);
    expect(result.passed).toBe(false);
  });
  test("cleanup is included after settled setup/assertion failure but never races setup", () => {
    const state = new Lifecycle();
    expect(() => state.cleanupAllowed()).toThrow("provisioning_unsettled");
    state.beginSetup();
    expect(() => state.cleanupAllowed()).toThrow("provisioning_unsettled");
    state.settleSetup(false, new Error(secret));
    expect(() => state.cleanupAllowed()).not.toThrow();
    expect(state.phases.deploy.outcome).toBe("failed");
    expect(JSON.stringify(state)).not.toContain(secret);
    state.settleSetup(true);
    state.phases.health = { outcome: "failed", failure: { code: "health_failure" } };
    expect(() => state.cleanupAllowed()).not.toThrow();
  });
  test("safe failures discard raw exception text and invalid status", () => {
    expect(safeFailure(new Error(secret))).toEqual({ code: "native_failure" });
    expect(safeFailure(new InfraFailure("metadata_http", 403))).toEqual({
      code: "metadata_http",
      status: 403,
    });
    expect(safeFailure(new InfraFailure("metadata_http", 9000))).toEqual({ code: "metadata_http" });
  });
  test("forged diagnostic values are never retained", () => {
    const invalid = Object.assign(new InfraFailure("metadata_shape"), {
      detail: { field: secret, shape: "object" },
    });
    expect(safeFailure(invalid)).toEqual({ code: "metadata_shape" });
    const extra = Object.assign(new InfraFailure("metadata_shape"), {
      detail: { field: "resource.props", shape: "null", raw: secret },
    });
    expect(safeFailure(extra)).toEqual({
      code: "metadata_shape",
      detail: { field: "resource.props", shape: "null" },
    });
  });
  test("supported controls are scoped real Effect services", async () => {
    const controls = await Effect.runPromise(
      quietNative(
        Effect.gen(function* () {
          return {
            level: yield* References.MinimumLogLevel,
            tracing: yield* References.TracerEnabled,
          };
        }),
      ),
    );
    expect(controls).toEqual({ level: "None", tracing: false });
    expect(await Effect.runPromise(References.MinimumLogLevel)).not.toBe("None");
  });
  test("real Effect failure normalization retains only safe diagnostics", async () => {
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.tryPromise({
          try: async () => {
            throw Object.assign(
              new InfraFailure("metadata_shape", 200, {
                field: "resource.bindings",
                shape: "object",
              }),
              { cause: new Error(secret) },
            );
          },
          catch: normalizeFailure,
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("expected_failure");
    const failure = safeFailure(Cause.squash(exit.cause));
    expect(failure).toEqual({
      code: "metadata_shape",
      status: 200,
      detail: { field: "resource.bindings", shape: "object" },
    });
    expect(JSON.stringify(failure)).not.toContain(secret);
    expect(Cause.pretty(exit.cause)).not.toContain(secret);
  });
  test("real disabled and forged registration entrypoints do not run infrastructure tests", () => {
    const env = { ...process.env };
    delete env.KBPOD_INFRA_CHILD;
    delete env.KBPOD_INFRA_RUN;
    delete env.KBPOD_INFRA_NONCE;
    delete env.KBPOD_INFRA_RECOVERY;
    const disabled = Bun.spawnSync([process.execPath, "test", "./tests/infra.test.ts"], {
      env,
      timeout: 10_000,
    });
    expect(disabled.exitCode).toBe(0);
    expect(disabled.stderr.toString()).toContain("1 skip");
    const forged = Bun.spawnSync([process.execPath, "test", "./tests/infra.test.ts"], {
      env: { ...env, DO_NOT_TRACK: "1", KBPOD_INFRA_CHILD: "1", KBPOD_INFRA_RUN: "invalid" },
      timeout: 10_000,
    });
    expect(forged.exitCode).not.toBe(0);
    expect(forged.stderr.toString()).toContain("invalid_infra_registration");
    const recovery = Bun.spawnSync([process.execPath, "test", "./tests/infra/recovery.entry.ts"], {
      env,
      timeout: 10_000,
    });
    expect(recovery.exitCode).not.toBe(0);
    expect(recovery.stderr.toString()).toContain("invalid_recovery_registration");
  });
});

const account = "a".repeat(32);
const credentials = {
  accountId: account,
  origin: "https://alchemy-state-store.fixture.workers.dev",
  access: secret,
  stateToken: secret,
  expires: Date.now() + 3_600_000,
};
const id = "abcdef123456";
const stage = stageFor("live", id);
const worker = `kbpod-server-${stage}-${"c".repeat(16)}`;
const run: Run = {
  id,
  stage,
  mode: "live",
  parentPid: 1,
  nonceHash: "fixture",
  accountHash: digest(account),
  stateOriginHash: digest(credentials.origin),
  createdAt: 1,
  source: {},
  beforeWorkers: digest(JSON.stringify(["alchemy-state-store"])),
  beforeStages: digest("[]"),
};
const fixture =
  (override: Record<string, unknown> = {}) =>
  async (url: string, init: RequestInit) => {
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("manual");
    const path = new URL(url).pathname.replace(/^\/client\/v4/, "");
    const bodies: Record<string, unknown> = {
      "/version": { version: 7 },
      [`/accounts/${account}`]: { success: true, result: { id: account } },
      [`/accounts/${account}/workers/scripts`]: {
        success: true,
        result: [{ id: "alchemy-state-store" }],
      },
      "/state/stacks/kbpod/stages": [],
      [`/state/stacks/kbpod/stages/${stage}/resources`]: [],
      [`/state/stacks/kbpod/stages/${stage}/replaced-resources`]: [],
      ...override,
    };
    return Response.json(bodies[path] ?? { success: false });
  };
describe("authoritative metadata guards (injected offline responses)", () => {
  test("preflight uses six GETs and records only digests", async () => {
    const observations: unknown[] = [];
    const client = new Metadata(
      credentials,
      6,
      signal(),
      (rows) => observations.push([...rows]),
      fixture(),
    );
    expect(await client.preflight(stage)).toEqual({
      beforeWorkers: run.beforeWorkers,
      beforeStages: run.beforeStages,
    });
    expect(client.observations).toHaveLength(6);
    expect(JSON.stringify(observations)).not.toContain(secret);
    await expect(client.version()).rejects.toThrow("metadata_budget");
  });
  test("account name is checked without adding a request or retaining its value", async () => {
    const client = new Metadata(
      { ...credentials, expectedAccountName: "approved-fixture-account" },
      1,
      signal(),
      undefined,
      fixture({
        [`/accounts/${account}`]: { success: true, result: { id: account, name: secret } },
      }),
    );
    await expect(client.account()).rejects.toThrow("target_mismatch");
    expect(client.observations).toHaveLength(1);
    expect(JSON.stringify(client.observations)).not.toContain(secret);
  });
  test("preexisting stage fails before native deployment", async () => {
    const client = new Metadata(
      credentials,
      6,
      signal(),
      undefined,
      fixture({ "/state/stacks/kbpod/stages": [stage] }),
    );
    await expect(client.preflight(stage)).rejects.toThrow("stage_collision");
  });
  test("postcheck proves absence without deleting or inspecting shared data", async () => {
    const client = new Metadata(credentials, 4, signal(), undefined, fixture());
    const result = await client.verify(run);
    expect(result.stageAbsent).toBe(true);
    expect(result.individualSharedDataInventory).toBe(false);
    expect(client.observations).toHaveLength(4);
  });
  test("changed unrelated inventory fails verification", async () => {
    const client = new Metadata(
      credentials,
      4,
      signal(),
      undefined,
      fixture({
        [`/accounts/${account}/workers/scripts`]: {
          success: true,
          result: [{ id: "alchemy-state-store" }, { id: secret }],
        },
      }),
    );
    await expect(client.verify(run)).rejects.toThrow("inventory_changed");
  });
  test("sole owned live Server creation is proven before cleanup", async () => {
    const prefix = `/state/stacks/kbpod/stages/${stage}`;
    const client = new Metadata(
      credentials,
      6,
      signal(),
      undefined,
      fixture({
        [`${prefix}/resources`]: ["Server"],
        [`${prefix}/resources/Server`]: serverState("live", worker, account),
        [`/accounts/${account}/workers/scripts`]: {
          success: true,
          result: [{ id: "alchemy-state-store" }, { id: worker, tag: "tag" }],
        },
        [`/accounts/${account}/workers/scripts/${worker}/settings`]: {
          success: true,
          result: {
            bindings: generatedNames.map((name) => ({ name, type: "plain_text", text: secret })),
          },
        },
      }),
    );
    const evidence = await client.guardCleanup(run, true);
    expect(evidence.created).toBe(true);
    expect(evidence.worker).toBe(worker);
    expect(client.observations).toHaveLength(5);
    expect(JSON.stringify(evidence)).not.toContain(secret);
  });
  test.each([
    { setupPassed: false, status: "creating", bindings: [], accepted: true },
    { setupPassed: true, status: "created", bindings: [], accepted: false },
    { setupPassed: false, status: "created", bindings: [], accepted: false },
    {
      setupPassed: false,
      status: "creating",
      bindings: [{ name: secret, type: "secret_text" }],
      accepted: false,
    },
    {
      setupPassed: false,
      status: "creating",
      bindings: [{ name: secret, type: "d1" }],
      accepted: false,
    },
  ])(
    "partial placeholder exception retains ownership and binding restrictions: %j",
    async ({ setupPassed, status, bindings, accepted }) => {
      const prefix = `/state/stacks/kbpod/stages/${stage}`;
      const responses = {
        [`${prefix}/resources`]: ["Server"],
        [`${prefix}/resources/Server`]: {
          ...serverState("live", worker, account),
          status,
        },
        [`/accounts/${account}/workers/scripts`]: {
          success: true,
          result: [{ id: "alchemy-state-store" }, { id: worker, tag: "tag" }],
        },
        [`/accounts/${account}/workers/scripts/${worker}/settings`]: {
          success: true,
          result: { bindings },
        },
      };
      const client = new Metadata(credentials, 6, signal(), undefined, fixture(responses));
      if (accepted) {
        const evidence = await client.guardCleanup(run, setupPassed);
        expect(evidence.bindings?.placeholder).toBe(true);
        expect(evidence.worker).toBe(worker);
        expect(client.observations).toHaveLength(5);
        const foreign = new Metadata(
          credentials,
          6,
          signal(),
          undefined,
          fixture({
            ...responses,
            [`/accounts/${account}/workers/scripts`]: {
              success: true,
              result: [{ id: "alchemy-state-store" }, { id: worker, tag: "foreign-tag" }],
            },
          }),
        );
        await expect(foreign.guardCleanup(run, false)).rejects.toThrow("unexpected_resource");
      } else
        await expect(client.guardCleanup(run, setupPassed)).rejects.toThrow("unexpected_binding");
    },
  );
  test.each([
    { value: undefined, shape: "missing" },
    { value: {}, shape: "object" },
    { value: null, shape: "null" },
    { value: secret, shape: "string" },
    { value: 1, shape: "number" },
    { value: false, shape: "boolean" },
  ])("state bindings reject unsupported $shape with safe diagnostics", async ({ value, shape }) => {
    const prefix = `/state/stacks/kbpod/stages/${stage}`;
    const client = new Metadata(
      credentials,
      3,
      signal(),
      undefined,
      fixture({
        [`${prefix}/resources`]: ["Server"],
        [`${prefix}/resources/Server`]: {
          ...serverState("live", worker, account),
          bindings: value,
        },
      }),
    );
    const failure = await client.guardCleanup(run, true).then(() => undefined, safeFailure);
    expect(failure).toEqual({
      code: "metadata_shape",
      detail: { field: "resource.bindings", shape },
    });
    expect(client.observations).toHaveLength(3);
    expect(JSON.stringify(failure)).not.toContain(secret);
  });
  test("nonempty supported state bindings remain forbidden", async () => {
    const prefix = `/state/stacks/kbpod/stages/${stage}`;
    const client = new Metadata(
      credentials,
      3,
      signal(),
      undefined,
      fixture({
        [`${prefix}/resources`]: ["Server"],
        [`${prefix}/resources/Server`]: {
          ...serverState("live", worker, account),
          bindings: [{ data: secret }],
        },
      }),
    );
    await expect(client.guardCleanup(run, true)).rejects.toThrow("unexpected_binding");
  });
  test.each(["props", "attr"] as const)(
    "malformed %s retains its safe failing field",
    async (field) => {
      const prefix = `/state/stacks/kbpod/stages/${stage}`;
      const client = new Metadata(
        credentials,
        3,
        signal(),
        undefined,
        fixture({
          [`${prefix}/resources`]: ["Server"],
          [`${prefix}/resources/Server`]: {
            ...serverState("live", worker, account),
            [field]: [secret],
          },
        }),
      );
      expect(await client.guardCleanup(run, true).then(() => undefined, safeFailure)).toEqual({
        code: "metadata_shape",
        detail: { field: `resource.${field}`, shape: "array" },
      });
    },
  );
  test("source-conformant local row survives JSON omission of undefined attributes", async () => {
    const localRun = { ...run, mode: "local" as const, stage: stageFor("local", id) };
    const name = `kbpod-server-${localRun.stage}-${"c".repeat(16)}`;
    const prefix = `/state/stacks/kbpod/stages/${localRun.stage}`;
    const client = new Metadata(
      credentials,
      3,
      signal(),
      undefined,
      fixture({
        [`${prefix}/resources`]: ["Server"],
        [`${prefix}/replaced-resources`]: [],
        [`${prefix}/resources/Server`]: serverState("local", name, account),
      }),
    );
    expect((await client.guardCleanup(localRun, true)).created).toBe(true);
    expect(client.observations).toHaveLength(3);
  });
  test("invalid JSON reports no body text", async () => {
    const client = new Metadata(
      credentials,
      1,
      signal(),
      undefined,
      async () => new Response(secret),
    );
    const failure = await client.version().then(() => undefined, safeFailure);
    expect(failure).toEqual({
      code: "metadata_shape",
      status: 200,
      detail: { field: "response", shape: "invalid_json" },
    });
    expect(JSON.stringify(failure)).not.toContain(secret);
  });
  test.each(["owned", "absent", "partial", "foreign-stage", "wrong-target", "bad-shape"])(
    "exact recovery inspection: %s",
    async (kind) => {
      const target = "e2e-local-22bfea207d84";
      const recoveryRun = {
        ...run,
        mode: "local" as const,
        stage: kind === "wrong-target" ? stage : target,
      };
      const name = `kbpod-server-${target}-${"c".repeat(16)}`;
      const prefix = `/state/stacks/kbpod/stages/${target}`;
      const client = new Metadata(
        credentials,
        7,
        signal(),
        undefined,
        fixture({
          "/state/stacks/kbpod/stages":
            kind === "absent" ? [] : kind === "foreign-stage" ? [target, secret] : [target],
          [`${prefix}/resources`]: kind === "absent" ? [] : ["Server"],
          [`${prefix}/replaced-resources`]: [],
          [`${prefix}/resources/Server`]: {
            ...serverState("local", name, account),
            ...(kind === "partial" ? { status: "creating" } : {}),
            ...(kind === "bad-shape" ? { bindings: {} } : {}),
          },
        }),
      );
      if (["owned", "absent"].includes(kind)) {
        expect((await client.inspectRecovery(recoveryRun)).absent).toBe(kind === "absent");
        expect(client.observations).toHaveLength(kind === "absent" ? 6 : 7);
      } else {
        const failure = await client
          .inspectRecovery(recoveryRun)
          .then(() => undefined, safeFailure);
        expect(failure).toBeDefined();
        expect(JSON.stringify(failure)).not.toContain(secret);
        if (kind === "wrong-target") expect(client.observations).toHaveLength(0);
      }
    },
  );
  test("foreign resources fail closed and never become deletion targets", async () => {
    const client = new Metadata(
      credentials,
      6,
      signal(),
      undefined,
      fixture({ [`/state/stacks/kbpod/stages/${stage}/resources`]: ["Server", secret] }),
    );
    await expect(client.guardCleanup(run, true)).rejects.toThrow("unexpected_resource");
  });
});
