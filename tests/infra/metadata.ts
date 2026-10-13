import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as Schema from "effect/Schema";
import { digest, readJson, type Run } from "./files.ts";
import { budgets, InfraFailure, requireThat, validateBindings } from "./policy.ts";

const Profile = Schema.Struct({
  format: Schema.Literal("alchemy.profile/v1"),
  provider: Schema.Literal("Cloudflare"),
  values: Schema.Struct({
    method: Schema.Literal("oauth"),
    accountId: Schema.String,
    access: Schema.String,
    expires: Schema.Number,
  }),
});
const Cache = Schema.Struct({
  accountId: Schema.String,
  url: Schema.String,
  authToken: Schema.String,
});
const ObjectValue = Schema.Record(Schema.String, Schema.Unknown);
const object = (value: unknown) => {
  try {
    return Schema.decodeUnknownSync(ObjectValue)(value);
  } catch {
    throw new InfraFailure("metadata_shape");
  }
};
const strings = (value: unknown) => {
  try {
    return Schema.decodeUnknownSync(Schema.Array(Schema.String))(value);
  } catch {
    throw new InfraFailure("metadata_shape");
  }
};
export function readCredentials(accountId: string, origin: string) {
  const home = join(homedir(), ".alchemy");
  const profile = Schema.decodeUnknownSync(Profile)(
    readJson(join(home, "profiles/kbpod-dev/cloudflare.json")),
  );
  const cache = Schema.decodeUnknownSync(Cache)(
    readJson(join(home, "credentials/kbpod-dev/cloudflare-state-store.json")),
  );
  const state = new URL(cache.url);
  requireThat(
    /^[a-f0-9]{32}$/i.test(accountId) &&
      profile.values.accountId === accountId &&
      cache.accountId === accountId &&
      state.origin === origin &&
      state.protocol === "https:" &&
      state.hostname.startsWith("alchemy-state-store.") &&
      state.hostname.endsWith(".workers.dev") &&
      !state.username &&
      !state.password &&
      state.pathname === "/" &&
      !state.search &&
      !state.hash,
    "target_mismatch",
  );
  return {
    accountId,
    origin,
    ...(process.env.KBPOD_INFRA_ACCOUNT_NAME
      ? { expectedAccountName: process.env.KBPOD_INFRA_ACCOUNT_NAME }
      : {}),
    access: profile.values.access,
    expires: profile.values.expires,
    stateToken: cache.authToken,
  };
}
export function guardLocalFiles() {
  requireThat(!readdirSync(".").some((p) => p.startsWith(".env") && p !== ".env.example"));
  const lock = join(homedir(), ".alchemy/lock");
  requireThat(
    !existsSync(lock) ||
      !readdirSync(lock).some((p) => p.includes("kbpod-dev") && p.endsWith(".lock")),
  );
  const bootstrap = ".alchemy/state/CloudflareStateStore";
  requireThat(
    !existsSync(bootstrap) ||
      !readdirSync(bootstrap, { recursive: true }).some((p) => String(p).endsWith(".json")),
  );
}
// Only called by the explicit supervisor, never by default discovery or the child.
export async function refreshOwnProfile(signal: AbortSignal, onRequest: () => void) {
  // beta81 does not export this registration-only layer publicly. Use its installed
  // declaration for types and its exact pinned source at runtime, without building providers/state.
  const cloudflareAuthUrl = new URL(
    "../../node_modules/alchemy/src/Cloudflare/Auth/AuthProvider.ts",
    import.meta.url,
  ).href;
  const [
    Effect,
    FetchHttpClient,
    Auth,
    Profiles,
    Credentials,
    Cloudflare,
    Platform,
    Interaction,
    Controls,
  ] = await Promise.all([
    import("effect/Effect"),
    import("effect/http/FetchHttpClient"),
    import("alchemy/Auth/AuthProvider"),
    import("alchemy/Auth/Profile"),
    import("alchemy/Auth/Credentials"),
    import(cloudflareAuthUrl) as Promise<
      typeof import("../../node_modules/alchemy/lib/Cloudflare/Auth/AuthProvider.js")
    >,
    import("alchemy/Util/PlatformServices"),
    import("alchemy/Interaction"),
    import("./controls.ts"),
  ]);
  let count = 0;
  const fetchToken: typeof fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      requireThat(
        String(input) === "https://dash.cloudflare.com/oauth2/token" &&
          init?.method === "POST" &&
          count === 0,
        "auth_failure",
      );
      count++;
      onRequest();
      return fetch(input, {
        ...init,
        redirect: "error",
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(15_000),
          ...(init.signal ? [init.signal] : []),
        ]),
      });
    },
    { preconnect: fetch.preconnect },
  );
  const program = Effect.gen(function* () {
    const store = yield* Profiles.ProfileStore;
    const auth = yield* Auth.getAuthProvider("Cloudflare");
    const config = yield* store.loadProviderConfig(auth, "kbpod-dev");
    yield* auth.read("kbpod-dev", config, (next) =>
      store
        .setProviderConfig("kbpod-dev", "Cloudflare", next)
        .pipe(Effect.mapError(() => new Auth.AuthError({ message: "profile_persist_failed" }))),
    );
  }).pipe(
    Effect.provide(Cloudflare.CloudflareAuth),
    Effect.provide(Profiles.ProfileStoreLive),
    Effect.provide(Credentials.CredentialsStoreLive),
    Effect.provideService(Auth.AuthProviders, {}),
    Effect.provide(Platform.PlatformServices),
    Effect.provide(Interaction.layerNonInteractive()),
    Effect.provideService(FetchHttpClient.Fetch, fetchToken),
    Effect.scoped,
    Effect.timeout("20 seconds"),
    Controls.quietNative,
  );
  try {
    await Effect.runPromise(program, { signal });
  } catch {
    throw new InfraFailure("auth_failure");
  }
  return count;
}

export interface MetadataObservation {
  operation: string;
  status?: number;
  media?: "json" | "html" | "other" | "missing";
}
export class Metadata {
  readonly observations: MetadataObservation[] = [];
  constructor(
    private readonly credentials: ReturnType<typeof readCredentials>,
    private readonly limit: number,
    private readonly signal: AbortSignal,
    private readonly record: (observations: MetadataObservation[]) => void = () => undefined,
    private readonly fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
  ) {}
  private async get(
    operation: string,
    path: string,
    state = false,
    publicRequest = false,
  ): Promise<unknown> {
    requireThat(this.observations.length < this.limit && !this.signal.aborted, "metadata_budget");
    const entry: MetadataObservation = { operation };
    this.observations.push(entry);
    this.record(this.observations);
    const c = this.credentials;
    const base = state ? c.origin : `https://api.cloudflare.com/client/v4/accounts/${c.accountId}`;
    try {
      const response = await this.fetcher(`${base}${path}`, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.any([this.signal, AbortSignal.timeout(budgets.metadataRequest)]),
        headers: publicRequest
          ? undefined
          : {
              Authorization: `Bearer ${state ? c.stateToken : c.access}`,
              Accept: "application/json",
            },
      });
      entry.status = response.status;
      const media = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      entry.media =
        media === "application/json"
          ? "json"
          : media === "text/html"
            ? "html"
            : media
              ? "other"
              : "missing";
      this.record(this.observations);
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new InfraFailure("metadata_http", response.status);
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (reader)
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.length;
          if (bytes > 65_536) {
            await reader.cancel();
            throw new InfraFailure("metadata_shape");
          }
          chunks.push(next.value);
        }
      const body = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.length;
      }
      try {
        return JSON.parse(new TextDecoder().decode(body));
      } catch {
        throw new InfraFailure("metadata_shape");
      }
    } catch (error) {
      if (error instanceof InfraFailure) throw error;
      throw new InfraFailure("metadata_transport");
    }
  }
  private result(input: unknown) {
    const envelope = object(input);
    requireThat(envelope.success === true, "metadata_shape");
    return envelope.result;
  }
  private statePath(stage: string) {
    requireThat(/^e2e-(local|live)-[a-f0-9]{12}$/.test(stage));
    return `/state/stacks/kbpod/stages/${stage}`;
  }
  async version() {
    requireThat(
      object(await this.get("shared_version", "/version", true, true)).version === 7,
      "state_failure",
    );
  }
  async account() {
    const account = object(this.result(await this.get("account", "")));
    requireThat(
      account.id === this.credentials.accountId &&
        (this.credentials.expectedAccountName === undefined ||
          account.name === this.credentials.expectedAccountName),
      "target_mismatch",
    );
  }
  async inventory() {
    const data = await this.get("workers", "/workers/scripts");
    const result = this.result(data);
    requireThat(Array.isArray(result), "metadata_shape");
    const workers = result.map((value) => {
      const row = object(value);
      requireThat(typeof row.id === "string", "metadata_shape");
      return { name: row.id, tag: row.tag };
    });
    const info = object(data).result_info;
    if (info) {
      const count = object(info).total_count;
      requireThat(
        count === undefined || (typeof count === "number" && count <= workers.length),
        "metadata_shape",
      );
    }
    requireThat(
      workers.filter((w) => w.name === "alchemy-state-store").length === 1,
      "state_failure",
    );
    return workers;
  }
  async stages() {
    return strings(await this.get("stages", "/state/stacks/kbpod/stages", true));
  }
  async resources(stage: string) {
    return strings(await this.get("resources", `${this.statePath(stage)}/resources`, true));
  }
  async replaced(stage: string) {
    const rows = await this.get("replaced", `${this.statePath(stage)}/replaced-resources`, true);
    requireThat(Array.isArray(rows) && rows.length === 0, "unexpected_resource");
  }
  async server(stage: string) {
    return object(await this.get("server", `${this.statePath(stage)}/resources/Server`, true));
  }
  async settings(worker: string, ownedCreatingPlaceholder = false) {
    requireThat(/^[a-z0-9-]+$/.test(worker));
    return validateBindings(
      object(this.result(await this.get("settings", `/workers/scripts/${worker}/settings`)))
        .bindings,
      ownedCreatingPlaceholder,
    );
  }
  async preflight(stage: string) {
    await this.version();
    await this.account();
    const workers = await this.inventory();
    const stages = await this.stages();
    requireThat(
      !stages.includes(stage) && !workers.some((w) => w.name.includes(stage)),
      "stage_collision",
    );
    requireThat((await this.resources(stage)).length === 0, "stage_collision");
    await this.replaced(stage);
    return {
      beforeWorkers: digest(JSON.stringify(workers.map((w) => w.name).sort())),
      beforeStages: digest(JSON.stringify([...stages].sort())),
    };
  }
  async guardCleanup(run: Run, setupPassed: boolean) {
    requireThat(digest(this.credentials.accountId) === run.accountHash, "target_mismatch");
    const resources = await this.resources(run.stage);
    await this.replaced(run.stage);
    requireThat(
      resources.length <= 1 && resources.every((r) => r === "Server"),
      "unexpected_resource",
    );
    if (resources.length === 0) {
      requireThat(!setupPassed, "unexpected_resource");
      return { resourceCount: 0 };
    }
    const row = await this.server(run.stage);
    requireThat(
      row.fqn === "Server" &&
        row.logicalId === "Server" &&
        row.resourceType === "Cloudflare.Worker" &&
        row.providerMode === run.mode &&
        !row.old,
      "unexpected_resource",
    );
    const bindings = row.bindings === undefined ? {} : object(row.bindings);
    requireThat(Object.keys(bindings).length === 0, "unexpected_binding");
    const props = object(row.props);
    requireThat(
      ![
        "bindings",
        "durableObjects",
        "kvNamespaces",
        "r2Buckets",
        "d1Databases",
        "queues",
        "secrets",
        "routes",
        "domains",
        "env",
        "assets",
      ].some(
        (k) =>
          props[k] !== undefined && props[k] !== null && Object.keys(Object(props[k])).length > 0,
      ),
      "unexpected_resource",
    );
    const attr = row.attr === undefined ? {} : object(row.attr);
    if (setupPassed)
      requireThat(["created", "updated"].includes(String(row.status)), "unexpected_resource");
    const worker = attr.workerName;
    // Partial setup can have no outputs yet; the fresh stage still owns only its one declared Server.
    if (worker === undefined) {
      requireThat(!setupPassed, "unexpected_resource");
      return { resourceCount: 1, partial: true };
    }
    requireThat(
      typeof worker === "string" &&
        worker.startsWith(`kbpod-server-${run.stage}-`) &&
        /^[a-z0-9-]{1,63}$/.test(worker),
      "unexpected_resource",
    );
    requireThat(
      !attr.namespace &&
        !attr.previewOf &&
        !attr.versionOf &&
        (!attr.routes || (Array.isArray(attr.routes) && attr.routes.length === 0)) &&
        (!attr.durableObjectNamespaces ||
          Object.keys(object(attr.durableObjectNamespaces)).length === 0),
      "unexpected_resource",
    );
    if (run.mode === "live") {
      requireThat(attr.accountId === this.credentials.accountId, "target_mismatch");
      const inventory = await this.inventory();
      const current = inventory.find((w) => w.name === worker);
      requireThat(
        current && typeof attr.workerId === "string" && current.tag === attr.workerId,
        "unexpected_resource",
      );
      // beta81 precreate persists an owned `creating` placeholder before uploading
      // the five runtime bindings. This exception is unavailable to completed setup.
      const bindingsSummary = await this.settings(
        worker,
        !setupPassed && row.status === "creating",
      );
      return { resourceCount: 1, worker, bindings: bindingsSummary, created: setupPassed };
    }
    requireThat(
      typeof attr.workerId === "string" && attr.workerId.startsWith("dev:"),
      "unexpected_resource",
    );
    return { resourceCount: 1, worker, local: true, created: setupPassed };
  }
  async verify(run: Run) {
    await this.version();
    const workers = await this.inventory();
    requireThat(
      !workers.some((w) => w.name.includes(run.stage)) &&
        digest(JSON.stringify(workers.map((w) => w.name).sort())) === run.beforeWorkers,
      "inventory_changed",
    );
    requireThat((await this.resources(run.stage)).length === 0, "verification_failed");
    const stages = await this.stages();
    requireThat(
      !stages.includes(run.stage) &&
        digest(JSON.stringify([...stages].sort())) === run.beforeStages,
      "inventory_changed",
    );
    return {
      workerAbsent: true,
      resources: 0,
      stageAbsent: true,
      otherWorkersUnchanged: true,
      otherStagesUnchanged: true,
      sharedVersion: 7,
      individualSharedDataInventory: false,
    };
  }
}
