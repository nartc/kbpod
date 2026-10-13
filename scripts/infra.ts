import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as Schema from "effect/Schema";
import { evidenceLimits, nativeEnvironment } from "../tests/infra/controls.ts";
import { digest, readJson, type Run, sourceIdentity, writeJson } from "../tests/infra/files.ts";
import {
  guardLocalFiles,
  Metadata,
  readCredentials,
  refreshOwnProfile,
} from "../tests/infra/metadata.ts";
import {
  budgets,
  InfraFailure,
  Mode,
  requireThat,
  safeFailure,
  stageFor,
  validateEnvironment,
} from "../tests/infra/policy.ts";

const Child = Schema.Struct({
  phases: Schema.Struct({
    deploy: Schema.Struct({ outcome: Schema.String }),
    health: Schema.Struct({ outcome: Schema.String }),
    cleanup: Schema.Struct({ outcome: Schema.String }),
  }),
  attempts: Schema.Array(Schema.Unknown),
  cleanupObservations: Schema.Array(Schema.Unknown),
  localPort: Schema.optional(Schema.Number),
});
const groupGone = (pid: number) => {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
  }
};
const listenerGone = (port?: number) => {
  if (port === undefined) return true;
  requireThat(Number.isInteger(port) && port > 0 && port <= 65535);
  const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  return result.status === 1 && result.stdout.trim() === "";
};

// Supervises the native Bun test; never provisions or destroys resources itself.
export async function runInfrastructure(input: readonly string[]) {
  const started = Date.now();
  let directory: string | undefined;
  let run: Run | undefined;
  let processPid: number | undefined;
  const receipt: Record<string, unknown> = {
    startedAt: new Date(started).toISOString(),
    result: "preparing",
    phase: "configuration",
    oauthRefreshPosts: 0,
    evidenceLimits,
  };
  const persist = () => {
    if (directory) writeJson(join(directory, "receipt.json"), receipt);
  };
  try {
    requireThat(input.length === 1 && Schema.is(Mode)(input[0]));
    const mode = input[0];
    validateEnvironment(process.env);
    // Set before any dynamic SDK auth import; no persistent user-wide setting.
    process.env.DO_NOT_TRACK = nativeEnvironment(process.env).DO_NOT_TRACK;
    guardLocalFiles();
    requireThat(
      !process.env.KBPOD_INFRA_CHILD &&
        !process.env.KBPOD_INFRA_NONCE &&
        !process.env.KBPOD_INFRA_RUN,
    );
    requireThat(Bun.version === "1.4.2");
    const alchemy = JSON.parse(readFileSync("node_modules/alchemy/package.json", "utf8"));
    requireThat(alchemy.version === "2.0.0-beta.81");
    const expectedCommit = process.env.KBPOD_INFRA_APPROVED_COMMIT ?? "";
    const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", timeout: 5_000 });
    const status = spawnSync("git", ["status", "--porcelain"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    requireThat(
      /^[a-f0-9]{40}$/.test(expectedCommit) &&
        head.status === 0 &&
        head.stdout.trim() === expectedCommit &&
        status.status === 0 &&
        status.stdout.trim() === "",
      "invalid_configuration",
    );
    receipt.commit = expectedCommit;
    const account = process.env.KBPOD_INFRA_ACCOUNT_ID ?? "";
    const origin = process.env.KBPOD_INFRA_STATE_ORIGIN ?? "";
    let credentials = readCredentials(account, origin);
    if (mode === "live") {
      const localId = process.env.KBPOD_INFRA_LOCAL_RUN ?? "";
      requireThat(/^[a-f0-9]{12}$/.test(localId), "invalid_configuration");
      const localDirectory = resolve(".alchemy/health-tests", localId);
      const previous = Schema.decodeUnknownSync(
        Schema.Struct({
          result: Schema.Literal("passed"),
          mode: Schema.Literal("local"),
          commit: Schema.Literal(expectedCommit),
          removal: Schema.Struct({
            stageAbsent: Schema.Literal(true),
            workerAbsent: Schema.Literal(true),
          }),
        }),
      )(readJson(join(localDirectory, "receipt.json")));
      const localRun = Schema.decodeUnknownSync(
        Schema.Struct({
          mode: Schema.Literal("local"),
          accountHash: Schema.String,
          stateOriginHash: Schema.String,
          source: Schema.Record(Schema.String, Schema.String),
        }),
      )(readJson(join(localDirectory, "run.json")));
      requireThat(
        previous.removal.stageAbsent &&
          localRun.accountHash === digest(account) &&
          localRun.stateOriginHash === digest(origin) &&
          Object.entries(sourceIdentity()).every(([path, hash]) => localRun.source[path] === hash),
        "target_mismatch",
      );
    }
    const id = randomBytes(6).toString("hex");
    const stage = stageFor(mode, id);
    directory = resolve(".alchemy/health-tests", id);
    mkdirSync(directory, { recursive: false });
    receipt.mode = mode;
    receipt.stage = stage;
    receipt.id = id;
    persist();
    receipt.phase = "preflight";
    const preSignal = AbortSignal.timeout(budgets.preflight);
    if (credentials.expires < Date.now() + budgets.overall + 60_000) {
      await refreshOwnProfile(preSignal, () => {
        receipt.oauthRefreshPosts = 1;
        persist();
      });
      credentials = readCredentials(account, origin);
    }
    requireThat(credentials.expires >= Date.now() + budgets.overall + 60_000, "auth_failure");
    const preflight = new Metadata(credentials, 6, preSignal, (observations) => {
      receipt.preflightObservations = observations;
      persist();
    });
    const before = await preflight.preflight(stage);
    const nonce = randomBytes(24).toString("hex");
    run = {
      id,
      stage,
      mode,
      parentPid: process.pid,
      nonceHash: digest(nonce),
      accountHash: digest(account),
      stateOriginHash: digest(origin),
      createdAt: Date.now(),
      source: sourceIdentity(),
      ...before,
    };
    writeJson(join(directory, "run.json"), run, true);
    receipt.source = run.source;
    receipt.phase = "native_lifecycle";
    receipt.result = "running";
    persist();
    const nativeResult = await new Promise<{ code: number | null; stopped: boolean }>(
      (resolveResult, reject) => {
        const child = spawn(process.execPath, ["test", "./tests/infra.test.ts"], {
          cwd: process.cwd(),
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...nativeEnvironment(process.env),
            KBPOD_INFRA_CHILD: "1",
            KBPOD_INFRA_RUN: id,
            KBPOD_INFRA_NONCE: nonce,
          },
        });
        processPid = child.pid;
        receipt.pid = processPid;
        persist();
        const timers: ReturnType<typeof setTimeout>[] = [];
        let stopped = false;
        let bytes = 0;
        const send = (signal: NodeJS.Signals) => {
          // Never signal a potentially reused group after its original leader exited.
          // Observed surviving group members fail verification; detached descendants
          // are not independently attested. Neither case authorizes a sweep.
          if (child.exitCode !== null || child.signalCode !== null) return;
          if (processPid !== undefined && !groupGone(processPid)) {
            try {
              process.kill(-processPid, signal);
            } catch {
              /* exit race; verification decides */
            }
          }
        };
        const stop = () => {
          if (stopped) return;
          stopped = true;
          receipt.deadlineOrOutputStop = true;
          persist();
          send("SIGINT");
          timers.push(
            setTimeout(() => send("SIGTERM"), 20_000),
            setTimeout(() => send("SIGKILL"), 25_000),
          );
          timers.push(
            setTimeout(() => {
              for (const timer of timers) clearTimeout(timer);
              child.stdout?.destroy();
              child.stderr?.destroy();
              child.unref();
              resolveResult({ code: child.exitCode, stopped: true });
            }, 30_000),
          );
        };
        const discard = (data: Buffer) => {
          bytes += data.length;
          if (bytes > 4_000_000) stop();
        };
        child.stdout?.on("data", discard);
        child.stderr?.on("data", discard);
        timers.push(setTimeout(stop, Math.max(0, budgets.execution - (Date.now() - started))));
        child.on("error", () => {
          for (const timer of timers) clearTimeout(timer);
          reject(new InfraFailure("process_failed"));
        });
        child.on("close", (code) => {
          for (const timer of timers) clearTimeout(timer);
          receipt.discardedOutputBytes = bytes;
          resolveResult({ code, stopped });
        });
      },
    );
    receipt.nativeExit = nativeResult.code;
    receipt.observedTestGroupStopped = processPid !== undefined && groupGone(processPid);
    receipt.nativeHostFinalizers =
      nativeResult.code === 0 && !nativeResult.stopped
        ? "adapter_completed_errors_may_be_ignored"
        : "not_confirmed";
    let childResult: typeof Child.Type | undefined;
    try {
      childResult = Schema.decodeUnknownSync(Child)(readJson(join(directory, "child.json")));
    } catch {
      /* no trusted child outcome */
    }
    receipt.listenerStopped = listenerGone(childResult?.localPort);
    receipt.healthRequestCount = childResult?.attempts.length ?? 0;
    const cleanupGets = childResult?.cleanupObservations.length ?? 0;
    const preGets = preflight.observations.length;
    requireThat(
      preGets + cleanupGets + 4 <= budgets.metadataCount &&
        (childResult?.attempts.length ?? 0) <= budgets.healthCount,
      "metadata_budget",
    );
    // Read-only postchecks, not another cleanup. A known surviving group/listener
    // fails; this is not a claim that every detached descendant was observed.
    requireThat(
      receipt.observedTestGroupStopped === true && receipt.listenerStopped === true,
      "verification_failed",
    );
    requireThat(Date.now() - started + budgets.verification <= budgets.overall, "timeout");
    receipt.phase = "verification";
    const post = new Metadata(
      readCredentials(account, origin),
      4,
      AbortSignal.timeout(budgets.verification),
      (observations) => {
        receipt.verificationObservations = observations;
        persist();
      },
    );
    receipt.removal = await post.verify(run);
    requireThat(
      !nativeResult.stopped &&
        nativeResult.code === 0 &&
        childResult !== undefined &&
        childResult.phases.deploy.outcome === "passed" &&
        childResult.phases.health.outcome === "passed" &&
        childResult.phases.cleanup.outcome === "passed",
      "cleanup_failed",
    );
    receipt.phase = "complete";
    receipt.result = "passed";
  } catch (error) {
    receipt.result = "failed";
    receipt.failure = safeFailure(error);
  }
  receipt.finishedAt = new Date().toISOString();
  receipt.elapsedMs = Date.now() - started;
  if (run)
    receipt.recovery = {
      stack: "kbpod",
      stage: run.stage,
      profile: "kbpod-dev",
      resource: "Server",
      noAutomaticRetry: true,
    };
  persist();
  return { exitCode: receipt.result === "passed" ? 0 : 1, receipt, directory };
}

if (import.meta.main) {
  // Parent directories are inert local receipt storage, not an infrastructure operation.
  mkdirSync(".alchemy/health-tests", { recursive: true });
  const result = await runInfrastructure(Bun.argv.slice(2));
  console.log(JSON.stringify(result.receipt, null, 2));
  process.exitCode = result.exitCode;
}
