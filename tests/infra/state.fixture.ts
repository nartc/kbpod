// Type-only SDK references: this module remains safe in default offline discovery.
import type { Worker, WorkerProps } from "alchemy/Cloudflare/Workers";
import type { CreatedResourceState } from "alchemy/State/ResourceState";
import type { Mode } from "./policy.ts";

export function serverState(mode: Mode, worker: string, account: string) {
    return {
        status: "created",
        resourceType: "Cloudflare.Worker",
        namespace: undefined,
        fqn: "Server",
        logicalId: "Server",
        instanceId: "b".repeat(32),
        providerVersion: 0,
        providerMode: mode,
        downstream: [],
        bindings: [],
        props: { main: "file:///fixture/worker.ts", env: {} },
        attr: {
            workerId: mode === "local" ? `dev:${worker}` : "tag",
            workerName: worker,
            namespace: undefined,
            logpush: undefined,
            url:
                mode === "local"
                    ? "http://localhost:1337"
                    : `https://${worker}.fixture.workers.dev`,
            urls:
                mode === "local"
                    ? ["http://localhost:1337"]
                    : [`https://${worker}.fixture.workers.dev`],
            domain: undefined,
            tags: [],
            durableObjectNamespaces: {},
            accountId: account,
            routes: [],
            crons: [],
        },
    } satisfies CreatedResourceState & { props: WorkerProps; attr: Worker["Attributes"] };
}
