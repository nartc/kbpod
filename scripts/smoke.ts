import * as Effect from "effect/Effect";
import {
  HealthCheckError,
  checkHealthResponse,
  classifyTransportError,
  formatHealthFailure,
} from "../tests/health-check.ts";

type HealthFetch = (url: URL, options: RequestInit) => Promise<Response>;

// Importing this module is inert. Tests inject fetch; only an explicit CLI invocation uses the network.
export const runSmoke = async (
  inputArgs: readonly string[],
  fetchHealth: HealthFetch = fetch,
): Promise<{ exitCode: 0 | 1; message: string }> => {
  const program = Effect.gen(function* () {
    const args = [...inputArgs];
    if (args[0] === "--") args.shift();
    const input = args[0];
    if (args.length !== 1 || !input) {
      return yield* Effect.fail(new HealthCheckError("usage"));
    }
    const base = yield* Effect.try({
      try: () => new URL(input),
      catch: () => new HealthCheckError("invalid_url"),
    });
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      base.pathname !== "/"
    ) {
      return yield* Effect.fail(new HealthCheckError("invalid_url"));
    }
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetchHealth(new URL("/health", base), {
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
          redirect: "error",
        }),
      catch: (error) => {
        const transport = classifyTransportError(error);
        return new HealthCheckError(transport === "timeout" ? "timeout" : "transport", {
          transport,
        });
      },
    });
    yield* checkHealthResponse(response);
    return base.origin;
  });

  try {
    const origin = await Effect.runPromise(program);
    return {
      exitCode: 0,
      message: `Health verified: ${origin}/health — 200 application/json {"status":"ok"}`,
    };
  } catch (error) {
    return { exitCode: 1, message: formatHealthFailure(error) };
  }
};

if (import.meta.main) {
  const result = await runSmoke(Bun.argv.slice(2));
  if (result.exitCode === 0) console.log(result.message);
  else console.error(result.message);
  process.exitCode = result.exitCode;
}
