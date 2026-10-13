import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as Schema from "effect/Schema";
import { Mode, requireThat, stageFor, validateEnvironment } from "./policy.ts";

export const digest = (value: string | Uint8Array) =>
    createHash("sha256").update(value).digest("hex");
export const runtimeFiles = [
    "alchemy.run.ts",
    "apps/server/src/worker.ts",
    "apps/server/src/http.ts",
    "packages/api/src/index.ts",
    "bun.lock",
    "package.json",
    "scripts/infra.ts",
    "scripts/smoke.ts",
    "tests/health-check.ts",
    "tests/infra.test.ts",
    "tests/infra/files.ts",
    "tests/infra/controls.ts",
    "tests/infra/policy.ts",
    "tests/infra/metadata.ts",
    "tests/infra/native.ts",
    "tests/infra/recovery.entry.ts",
    "tests/infra/recovery-native.ts",
    "node_modules/alchemy/src/Test/Bun.ts",
    "node_modules/alchemy/src/Test/Core.ts",
    "node_modules/alchemy/src/Cloudflare/Auth/AuthProvider.ts",
    "node_modules/alchemy/lib/Cloudflare/Auth/AuthProvider.d.ts",
    "node_modules/alchemy/src/Cloudflare/StateStore/State.ts",
    "node_modules/alchemy/src/Cloudflare/Workers/WorkerProvider.ts",
] as const;
export const sourceIdentity = () =>
    Object.fromEntries(runtimeFiles.map((p) => [p, digest(readFileSync(p))]));
export const Run = Schema.Struct({
    id: Schema.String,
    mode: Mode,
    stage: Schema.String,
    parentPid: Schema.Number,
    nonceHash: Schema.String,
    accountHash: Schema.String,
    stateOriginHash: Schema.String,
    createdAt: Schema.Number,
    source: Schema.Record(Schema.String, Schema.String),
    beforeWorkers: Schema.String,
    beforeStages: Schema.String,
    recoveryFrom: Schema.optional(Schema.Literal("22bfea207d84")),
    inspectionDeadline: Schema.optional(Schema.Number),
});
export type Run = typeof Run.Type;
export function readJson(path: string): unknown {
    return JSON.parse(readFileSync(path, "utf8"));
}
export function writeJson(path: string, value: unknown, exclusive = false) {
    mkdirSync(dirname(path), { recursive: true });
    if (exclusive)
        writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    else {
        const temporary = `${path}.${process.pid}.tmp`;
        writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
        renameSync(temporary, path);
    }
}
export function loadChildContext(env = process.env, parentPid = process.ppid) {
    validateEnvironment(env);
    requireThat(env.DO_NOT_TRACK === "1");
    requireThat(env.KBPOD_INFRA_CHILD === "1" && /^[a-f0-9]{12}$/.test(env.KBPOD_INFRA_RUN ?? ""));
    const directory = resolve(".alchemy/health-tests", env.KBPOD_INFRA_RUN ?? "");
    requireThat(existsSync(directory) && realpathSync(directory) === directory);
    const run = Schema.decodeUnknownSync(Run)(readJson(join(directory, "run.json")));
    requireThat(
        run.id === env.KBPOD_INFRA_RUN &&
            run.stage === stageFor(run.mode, run.recoveryFrom ?? run.id) &&
            (run.recoveryFrom === undefined
                ? env.KBPOD_INFRA_RECOVERY === undefined
                : run.mode === "local" && env.KBPOD_INFRA_RECOVERY === run.recoveryFrom) &&
            run.parentPid === parentPid &&
            run.nonceHash === digest(env.KBPOD_INFRA_NONCE ?? "") &&
            Date.now() - run.createdAt >= 0 &&
            Date.now() - run.createdAt < 900_000,
    );
    const current = sourceIdentity();
    requireThat(runtimeFiles.every((file) => run.source[file] === current[file]));
    return { run, directory };
}
