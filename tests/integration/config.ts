import { isAbsolute } from "node:path";

// Pure configuration: importing this helper never imports Alchemy or reads credentials.
export function integrationTarget(env: Record<string, string | undefined>): "local" | "cloud" {
    const target = env.KBPOD_TEST_TARGET;
    if (target !== "local" && target !== "cloud") {
        throw new Error("Set KBPOD_TEST_TARGET to local or cloud for the integration suite.");
    }
    if (env.ALCHEMY_TEST_DEV !== undefined) {
        throw new Error("Use KBPOD_TEST_TARGET, not Alchemy's test-dev override.");
    }
    if (env.DO_NOT_TRACK !== "1") {
        throw new Error("Set DO_NOT_TRACK=1 for native integration tests.");
    }
    return target;
}

export function integrationReportPath(env: Record<string, string | undefined>): string | undefined {
    const path = env.KBPOD_INTEGRATION_REPORT;
    if (path !== undefined && (!isAbsolute(path) || path.includes("\0"))) {
        throw new Error("Integration report path must be absolute.");
    }
    return path;
}
