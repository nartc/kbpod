import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidenceLimits, nativeEnvironment } from "./infra/controls.ts";
import { digest, type Run } from "./infra/files.ts";
import { Metadata } from "./infra/metadata.ts";
import {
  budgets,
  generatedNames,
  InfraFailure,
  Lifecycle,
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
  test("disabled and forged discovery never import Alchemy or fetch", () => {
    const directory = mkdtempSync(join(tmpdir(), "kbpod-infra-offline-"));
    try {
      const preload = join(directory, "no-cloud.ts");
      writeFileSync(
        preload,
        `import {plugin} from "bun"; plugin({name:"deny-alchemy",setup(b){b.onResolve({filter:/^alchemy(?:\\/|$)/},()=>{throw Error("ALCHEMY_IMPORT_FORBIDDEN")})}}); globalThis.fetch=()=>{throw Error("FETCH_FORBIDDEN")};`,
      );
      const env = { ...process.env };
      delete env.KBPOD_INFRA_CHILD;
      delete env.KBPOD_INFRA_RUN;
      delete env.KBPOD_INFRA_NONCE;
      const disabled = Bun.spawnSync(
        [process.execPath, "test", "--preload", preload, "./tests/infra.test.ts"],
        { env, timeout: 10_000 },
      );
      expect(disabled.exitCode).toBe(0);
      expect(disabled.stderr.toString()).not.toContain("ALCHEMY_IMPORT_FORBIDDEN");
      const forged = Bun.spawnSync(
        [process.execPath, "test", "--preload", preload, "./tests/infra.test.ts"],
        { env: { ...env, KBPOD_INFRA_CHILD: "1", KBPOD_INFRA_RUN: "invalid" }, timeout: 10_000 },
      );
      expect(forged.exitCode).not.toBe(0);
      expect(forged.stderr.toString()).toContain("invalid_infra_registration");
      expect(forged.stderr.toString()).not.toContain("ALCHEMY_IMPORT_FORBIDDEN");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("our native hook registration (isolated offline boundary fixtures)", () => {
  test.each([
    "success",
    "setup-failure",
    "assertion-failure",
    "cleanup-failure",
    "guard-failure",
    "unsettled",
    "deploy-timeout",
    "health-timeout",
    "cleanup-timeout",
  ])("%s records outcomes and cleanup independently", (scenario) => {
    const directory = mkdtempSync(join(tmpdir(), "kbpod-hooks-"));
    try {
      const entry = join(directory, "hooks.test.ts");
      const fixture = new URL("./infra/native-hook.fixture.ts", import.meta.url).pathname;
      writeFileSync(entry, `import ${JSON.stringify(fixture)};`);
      const result = Bun.spawnSync([process.execPath, "test", entry], {
        env: {
          ...process.env,
          KBPOD_FIXTURE_DIRECTORY: directory,
          KBPOD_FIXTURE_SCENARIO: scenario,
        },
        timeout: 5_000,
      });
      expect(result.exitCode).toBe(scenario === "success" ? 0 : 1);
      const receipt = JSON.parse(readFileSync(join(directory, "child.json"), "utf8"));
      const events = JSON.parse(readFileSync(join(directory, "events.json"), "utf8"));
      expect(events.deploy).toBe(1);
      expect(events.destroy).toBe(["guard-failure", "unsettled"].includes(scenario) ? 0 : 1);
      expect(receipt.phases.cleanup.outcome).toBe(
        scenario === "unsettled"
          ? "not_attempted"
          : ["cleanup-failure", "guard-failure", "cleanup-timeout"].includes(scenario)
            ? "failed"
            : "passed",
      );
      if (["setup-failure", "deploy-timeout"].includes(scenario))
        expect(receipt.setupSettled).toBe(true);
      if (["assertion-failure", "health-timeout"].includes(scenario))
        expect(receipt.phases.health.outcome).toBe("failed");
      expect(receipt.evidenceLimits).toEqual(evidenceLimits);
      expect(result.stdout.toString()).not.toContain("synthetic-private-exception");
      expect(JSON.stringify(receipt)).not.toContain("synthetic-private-exception");
      expect(result.stderr.toString()).not.toContain("synthetic-private-exception");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
const worker = `kbpod-server-${stage}-fixture`;
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
        [`${prefix}/resources/Server`]: {
          fqn: "Server",
          logicalId: "Server",
          resourceType: "Cloudflare.Worker",
          providerMode: "live",
          status: "created",
          bindings: {},
          props: { main: "fixture" },
          attr: { workerName: worker, workerId: "tag", accountId: account },
        },
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
          fqn: "Server",
          logicalId: "Server",
          resourceType: "Cloudflare.Worker",
          providerMode: "live",
          status,
          bindings: {},
          props: { main: "fixture" },
          attr: { workerName: worker, workerId: "tag", accountId: account },
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
