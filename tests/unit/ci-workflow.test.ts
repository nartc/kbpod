import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { HealthCheckError } from "../health-check.ts";
import { deploymentSettlement, integrationReport } from "../integration/report.ts";

type Step = {
    id?: string;
    uses?: string;
    run?: string;
    if?: string;
    env?: Record<string, string>;
    with?: Record<string, unknown>;
};
type Job = {
    name: string;
    needs?: string;
    if?: string;
    "runs-on": string;
    "timeout-minutes": number;
    concurrency?: Record<string, unknown>;
    env?: Record<string, string>;
    steps: Step[];
};
type Workflow = {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    jobs: Record<string, Job>;
};
const source = await Bun.file(new URL("../../.github/workflows/ci.yml", import.meta.url)).text();
const workflow = Bun.YAML.parse(source) as Workflow;
const { offline, cloud } = workflow.jobs;
if (!offline || !cloud) throw new Error("Expected both CI jobs");
const step = (id: string): Step => {
    const found = cloud.steps.find((entry) => entry.id === id);
    if (!found?.run) throw new Error("Missing workflow gate");
    return found;
};
const script = (id: string) => step(id).run ?? "";
const fixture = (check: (directory: string) => void) => {
    const directory = mkdtempSync(join(tmpdir(), "kbpod-ci-unit-"));
    try {
        check(directory);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
};
// Execute only the actual workflow's local gates/validator, never its native command.
const shell = (command: string, directory: string, env: Record<string, string>) => {
    const result = Bun.spawnSync(
        ["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", command],
        {
            cwd: directory,
            env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
            stdout: "pipe",
            stderr: "pipe",
        },
    );
    return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
};
const trusted = {
    HEAD_REPOSITORY: "nartc/kbpod",
    BASE_REPOSITORY: "nartc/kbpod",
    AUTHOR_TYPE: "User",
    ACTOR: "maintainer",
    TRIGGERING_ACTOR: "maintainer",
};
const stage = "stage=it-cloud-012345abcdef\n";
const success =
    stage +
    ["deploy", "health", "destroy"]
        .flatMap((phase) => [`phase=${phase}:started\n`, `phase=${phase}:passed\n`])
        .join("");
const secret = "SYNTHETIC-SECRET-DO-NOT-PRINT";

test("both stable checks run on PR events without path/draft skips or privileged triggers", () => {
    expect(workflow.on).toEqual({ pull_request: { types: ["opened", "synchronize", "reopened"] } });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(Object.keys(workflow.jobs)).toEqual(["offline", "cloud"]);
    expect([offline.name, cloud.name]).toEqual(["Offline checks", "Cloud integration"]);
    expect(cloud.needs).toBe("offline");
    expect(offline.if).toBeUndefined();
    expect(cloud.if).toBeUndefined();
    expect(cloud.steps[0]?.id).toBe("trust");
    expect(cloud.steps[1]?.id).toBe("paths");
    expect(cloud.steps[2]?.uses).toStartWith("actions/checkout@");
    expect(cloud.steps.filter((entry) => entry.id).map((entry) => entry.id)).toEqual([
        "trust",
        "paths",
        "fresh",
        "integration",
        "evidence",
    ]);
    expect(cloud.concurrency).toEqual({
        group: "kbpod-cloud-integration",
        "cancel-in-progress": false,
    });
    expect(cloud["timeout-minutes"]).toBe(20);
    expect(source).not.toMatch(
        /continue-on-error|upload-artifact|actions\/cache|pull_request_target|workflow_run/,
    );
});

test("fresh hosted checkouts use pinned actions and frozen Bun with no persistent Git credentials", () => {
    for (const job of [offline, cloud]) {
        expect(job["runs-on"]).toBe("ubuntu-24.04");
        const actions = job.steps.filter((entry) => entry.uses);
        expect(actions.map((entry) => entry.uses)).toEqual([
            "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
            "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
        ]);
        expect(actions[0]?.with).toEqual({ "persist-credentials": false });
        expect(actions[1]?.with).toEqual({ "bun-version": "1.4.2" });
        expect(job.steps.some((entry) => entry.run === "bun install --frozen-lockfile")).toBe(true);
    }
    expect(offline.steps.flatMap((entry) => (entry.run ? [entry.run] : []))).toEqual([
        "bun install --frozen-lockfile",
        "bun run format:check",
        "bun run lint",
        "bun run typecheck",
        "bun run test:unit",
    ]);
});

test("only the native step gets the account/token, and SDK output is discarded before launch", () => {
    expect(source.match(/secrets\.CLOUDFLARE_API_TOKEN/g)).toHaveLength(1);
    expect(step("integration").env).toEqual({
        CLOUDFLARE_ACCOUNT_ID: "7cae6ad8270c12d5328aebe85fc0528a",
        CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
        KBPOD_TEST_TARGET: "cloud",
        CI: "true",
    });
    expect(script("integration")).toContain("bun run test:integration >/dev/null 2>&1");
    expect(script("integration")).toContain('exit "$status"');
    expect(step("evidence").if).toBe("always()");
    expect(step("evidence").env).toEqual({ NATIVE_OUTCOME: "${{ steps.integration.outcome }}" });
    for (const entry of cloud.steps) {
        expect(entry.run ?? "").not.toContain("${{");
        if (entry.id !== "integration")
            expect(JSON.stringify(entry)).not.toContain("CLOUDFLARE_API_TOKEN");
    }
    // runner context is valid in step env, not job env (GitHub context table).
    expect(cloud.env).toBeUndefined();
    expect(step("paths").env).toEqual({
        ALCHEMY_HOME:
            "${{ runner.temp }}/kbpod-alchemy-${{ github.run_id }}-${{ github.run_attempt }}",
        KBPOD_INTEGRATION_REPORT:
            "${{ runner.temp }}/kbpod-integration-${{ github.run_id }}-${{ github.run_attempt }}.txt",
    });
});

test("run paths are exported through the runner's environment file", () =>
    fixture((directory) => {
        const envFile = join(directory, "github-env");
        const home = join(directory, "alchemy-home");
        const report = join(directory, "report.txt");
        const result = shell(script("paths"), directory, {
            GITHUB_ENV: envFile,
            ALCHEMY_HOME: home,
            KBPOD_INTEGRATION_REPORT: report,
        });
        expect(result.code).toBe(0);
        expect(readFileSync(envFile, "utf8")).toBe(
            `ALCHEMY_HOME=${home}\nKBPOD_INTEGRATION_REPORT=${report}\n`,
        );
    }));

test("a trusted human PR passes the actual trust gate", () =>
    fixture((directory) => {
        expect(shell(script("trust"), directory, trusted).code).toBe(0);
    }));

test.each([
    { HEAD_REPOSITORY: "outsider/kbpod" },
    { HEAD_REPOSITORY: "" },
    { BASE_REPOSITORY: "" },
    { AUTHOR_TYPE: "Bot" },
    { AUTHOR_TYPE: "" },
    { ACTOR: "dependabot[bot]" },
    { TRIGGERING_ACTOR: "renovate[bot]" },
    { ACTOR: "" },
    { TRIGGERING_ACTOR: "" },
    { HEAD_REPOSITORY: `$(printf ${secret});'"` },
])("untrusted or incomplete event fails without checkout: %j", (overrides) =>
    fixture((directory) => {
        const result = shell(script("trust"), directory, { ...trusted, ...overrides });
        expect(result.code).toBe(1);
        expect(result.output).not.toContain(secret);
    }),
);

test("event values are data, not shell expressions", () =>
    fixture((directory) => {
        const result = shell(script("trust"), directory, {
            ...trusted,
            ACTOR: `$(printf ${secret});'"`,
            TRIGGERING_ACTOR: `$(printf ${secret})`,
        });
        expect(result.code).toBe(0);
        expect(result.output).not.toContain(secret);
    }));

test.each(["", "synthetic-token"])(
    "credential prelude fails closed without printing token: %s",
    (token) =>
        fixture((directory) => {
            const prelude = script("integration").split("# Native command:")[0];
            if (!prelude || prelude.includes("bun run"))
                throw new Error("Unsafe credential fixture");
            const result = shell(prelude, directory, { CLOUDFLARE_API_TOKEN: token });
            expect(result.code).toBe(token ? 0 : 1);
            expect(result.output).not.toContain("synthetic-token");
        }),
);

test.each([
    "fresh",
    "project",
    "home",
    "project-symlink",
    "home-symlink",
    "report",
    "relative-home",
])("fresh-state gate checks paths without reading/deleting them: %s", (kind) =>
    fixture((directory) => {
        const home = join(directory, "alchemy-home");
        const report = join(directory, "report.txt");
        if (kind === "project") mkdirSync(join(directory, ".alchemy"));
        if (kind === "home") mkdirSync(home);
        if (kind === "project-symlink") symlinkSync("missing", join(directory, ".alchemy"));
        if (kind === "home-symlink") symlinkSync("missing", home);
        if (kind === "report") writeFileSync(report, secret);
        const result = shell(script("fresh"), directory, {
            ALCHEMY_HOME: kind === "relative-home" ? "relative" : home,
            KBPOD_INTEGRATION_REPORT: report,
        });
        expect(result.code).toBe(kind === "fresh" ? 0 : 1);
        expect(result.output).not.toContain(secret);
        if (kind === "report") expect(readFileSync(report, "utf8")).toBe(secret);
    }),
);

const evidence = (
    contents: string | undefined,
    outcome: string,
    check: (result: { code: number; output: string }, summary: string) => void,
) =>
    fixture((directory) => {
        const path = join(directory, "report.txt");
        const summary = join(directory, "summary.md");
        writeFileSync(summary, "");
        if (contents !== undefined) writeFileSync(path, contents);
        const result = shell(script("evidence"), directory, {
            KBPOD_INTEGRATION_REPORT: path,
            GITHUB_STEP_SUMMARY: summary,
            NATIVE_OUTCOME: outcome,
        });
        check(result, readFileSync(summary, "utf8"));
    });

test("evidence after a rejected trust gate fails with a fixed message, not a traceback", () =>
    fixture((directory) => {
        const result = shell(script("evidence"), directory, {});
        expect(result.code).toBe(1);
        expect(result.output).toBe(
            "::error::Integration evidence missing, malformed or incomplete; native lifecycle not verified.\n",
        );
    }));

test("the real report helper produces the workflow's accepted success grammar", () => {
    let contents = "";
    const report = integrationReport("it-cloud-012345abcdef", (line) => {
        contents += line;
    });
    for (const phase of ["deploy", "health", "destroy"] as const) {
        Effect.runSync(Effect.void.pipe(report.observe(phase)));
    }
    evidence(contents, "success", (result) => {
        expect(result.code).toBe(0);
    });
});

test.each(["failed", "unsettled", "health"])(
    "real helper %s evidence is safe and remains failed",
    (kind) => {
        let contents = "";
        const report = integrationReport("it-cloud-012345abcdef", (line) => {
            contents += line;
        });
        if (kind === "failed") {
            Effect.runSyncExit(
                Effect.fail({ _tag: "AuthError", message: secret }).pipe(report.observe("deploy")),
            );
        } else if (kind === "unsettled") {
            Effect.runSyncExit(deploymentSettlement().cleanup(Effect.void, report.unsettled()));
        } else {
            const error = new HealthCheckError("http_status", { status: 503, contentType: "html" });
            error.message = secret;
            Effect.runSyncExit(
                Effect.fail(error).pipe(
                    Effect.tapError(report.healthFailure),
                    report.observe("health"),
                ),
            );
        }
        evidence(contents, "failure", (result, summary) => {
            expect(result.code).toBe(1);
            expect(summary).toContain(contents.trim());
            expect(summary).toContain("Resources may remain");
            expect(summary + result.output).not.toContain(secret);
        });
    },
);

test("complete native success publishes only safe evidence", () =>
    evidence(success, "success", (result, summary) => {
        expect(result.code).toBe(0);
        expect(summary).toContain(stage.trim());
        expect(summary).toContain("not independent removal evidence");
    }));

test.each([
    undefined,
    "",
    success.slice(0, -1),
    `${success}${secret}\n`,
    `${success}\n`,
    `${stage}phase=deploy:${secret}\n`,
    `${stage}failure=${secret}\n`,
    `${stage}Health verification failed: reason=unexpected status=999\n`,
    `${stage}Health verification failed: reason=unexpected contentType=${secret}\n`,
    `${stage}Health verification failed: reason=unexpected transport=${secret}\n`,
    `${success}${stage}`,
    `${secret}\n${success}`,
    "x".repeat(8193),
])("malformed report is rejected wholesale", (contents) =>
    evidence(contents, "success", (result, summary) => {
        expect(result.code).toBe(1);
        expect(summary).toBe("");
        expect(result.output).not.toContain(secret);
    }),
);

test.each([
    [stage, "success"],
    [success, "failure"],
    [success, "cancelled"],
    [success, "skipped"],
    [success, ""],
    [success.replace("phase=destroy:passed\n", ""), "success"],
    [stage + "phase=deploy:started\ndestroy=blocked_unsettled_deploy\n", "failure"],
    [stage + "phase=deploy:started\nphase=deploy:failed\nfailure=auth_or_state\n", "failure"],
    [success + "phase=destroy:failed\n", "success"],
    [
        stage +
            "phase=health:failed\nHealth verification failed: reason=http_status status=503 contentType=html\n",
        "failure",
    ],
])("incomplete/failed native results stay red but retain safe detail", (contents, outcome) =>
    evidence(contents, outcome, (result, summary) => {
        expect(result.code).toBe(1);
        expect(summary).toContain(stage.trim());
        expect(summary).toContain("Resources may remain");
    }),
);
