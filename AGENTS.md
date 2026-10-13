# kbpod

A single-user knowledge base rendered as private podcast episodes. Read `docs/brief.md` (binding, change only with Chau's agreement) and `docs/progress.md` before work. Do one milestone per session; never mark a blocked check complete.

## Workspace and commands

Bun 1.4.2 workspaces, TypeScript, Effect 4; no Nx. Exact dependency pins and `bun.lock` are committed.

- `bun install --frozen-lockfile` — reproducible install.
- `bun run typecheck` — neutral API, Worker and Bun-tooling projects, no emit.
- `bun run lint`, `bun run format:check` — non-writing Biome checks.
- `bun run format` — format maintained code/config (never the brief).
- `bun test` / `bun run test` — cloud-free tests; do not import the stack or Worker resource.
- `bun run smoke -- <base-url>` — opt-in, single-request HTTP health assertions; never provisions resources. Failures report only fixed reason/status/media/transport categories, not raw inputs, headers, bodies or exceptions. Exit1 means failure; no retries or redirects.
- `/next-milestone` in Pi — project prompt, after project trust and `/reload`.
- `bun run cf <command> [options]` — project-local Cloudflare CLI `cf@1.0.0-beta.14`, explicitly launched with **Node 22.18+**, not Bun. Installation is approved; account/auth/query commands are separately gated. No global install or unpinned `bunx`. See `docs/cloudflare-logs.md`.

Cloud commands are **approval-gated**, not routine checks:
- `bun run test:infra:local` / `bun run test:infra:live` use native Alchemy setup/teardown on fresh isolated stages. Default `bun test` skips them without importing Alchemy. They need explicit per-run authority, private expected-target environment and (for live) a matching successful local run ID. D-7 permits normal same-account state-auth preview recovery and ordinary ignored SDK logs, with `DO_NOT_TRACK=1` and scoped controls. Never inspect/copy/attach/commit raw SDK logs. Detached descendants are not independently attested; observed survivors/failures still stop execution. See `docs/infrastructure-tests.md` for budgets, cleanup-on-failure and limits; command availability is not standing permission.
- `cf o11y telemetry query` queries historical logs using an API **POST**, not one of the previously approved seven GETs. Its documented API-token permission is **Workers Observability Write** even though it queries retained data. `cf` profiles are independent of Alchemy's `kbpod-dev`; never copy/reuse OAuth secrets implicitly. Live tails create temporary remote sessions and cannot recover old requests.
- Chau performs any approved login himself. The usual command is `bun alchemy profile edit --add Cloudflare`, but **do not run it yet from this project**: profile discovery can import the stack/build its layers. Accepted D-1 requires dashboard-only ownership preflight, then scoped authorization; a missing-default-entrypoint setup path avoids project stack discovery.
- **Current infrastructure state:** the unchanged shared-state bootstrap resume succeeded on2026-10-13, followed by real local health verification and separately approved dev deployment/health. The dev application Worker and `kbpod/dev` stage state were **intentionally destroyed on2026-10-13** after explicit approval and successful historical health checks. Authoritative metadata confirmed Worker absence, zero dev resources and no dev stage; the shared state service remains functional. Do not recreate the stage or run plan/dev/deploy/repair/cleanup without fresh scoped authorization. A later D-6/D-7 native local test at `aef0700` passed provisioning/health but its cleanup guard failed before destroy. Owned local stage `e2e-local-22bfea207d84` remained nonempty at postcheck; no live run followed. That stage requires separately approved recovery, not an automatic retry or sweep. The old bootstrap failure remains undiagnosed, not the current recovery target; read `docs/progress.md`.
- Use only the approved `kbpod-dev` profile/account: local `bun alchemy dev --stage dev --profile kbpod-dev`; deployed dev `bun alchemy deploy --stage dev --profile kbpod-dev` (deployment is separately gated).
- In Pi's real tmux TTY, Alchemy detects `.pi/agent` in PATH and disables prompts. Use the supported **UI-only** prefix `ALCHEMY_TUI=1` when interactive confirmation is needed. It does not enable `--yes` or `updateStateStore`; never use those blanket flags to work around a prompt failure.
- Even `plan`/local `dev` can bootstrap/upgrade remote state. State init can resume an incomplete bootstrap **without prompting** and upload a temporary edge-preview Worker to retrieve its auth secret before upgrade confirmation. No-prompt/`--dry-run` is not a cloud safety boundary. Ask before first use, credentials not supplied, replacements/deletion/destroy, model/TTS spend over a few dollars, departures from Decided, or any push.
- **Same-stage dev↔deploy is replacement; dev implies --yes.** Verify local first, stop it, get separate replacement/deploy approval, then deploy dev. Once dev is deployed, do not restart local dev on that stage without explicit replacement approval. No concurrent commands against a stage, no assumed cleanup on exit, no automatic destroy. `prod` is for milestone 8.

## Boundaries and conventions

- `packages/api`: shared schemas and HttpApi descriptions only. No Alchemy, Bun or Node imports.
- `apps/server/src/http.ts`: Effect handler/app Layer; `worker.ts`: sole application Worker edge. Root `alchemy.run.ts`: sole application Stack.
- Future `domain` owns entities/errors; `core` owns cloud-free stages/ports; web and CLI consume the shared contract. Do not create speculative packages before their milestone.
- One runtime per edge; no scattered `runPromise`. Schema at boundaries, typed errors, services/layers. Health has no application failure or settings requirement. Future secrets use `Config.Redacted`; `.env*` and `.alchemy/` stay ignored. Never print secrets.
- Worker/API TS projects exclude Bun types; lint rejects Bun/Node host adapters. Test/infra code can use Bun. Keep network smoke checks outside default test discovery.

## Verified API facts (installed 2026-10-12)

Effect `4.0.3`, Alchemy `2.0.0-beta.81`; installed declarations/source win over docs.

- Effect exports `effect/http`, `effect/http-api`, `effect/cli`, `effect/ai` and other v4 families; don't use Effect-3 platform imports. Later-feature APIs still need fresh verification.
- `Schema.Literal('ok')`, `Schema.Struct(fields)`, `Schema.decodeUnknownEffect(schema)(unknown)`: `effect/src/Schema.ts` (2731, 3585, 1523).
- `HttpApiEndpoint.get(name, path, { success })`; `HttpApiGroup.make(id).add(endpoint)`; `HttpApi.make(id).add(group)`. `HttpApiBuilder.group(api, id, handlers => handlers.handle(name, effectHandler))` builds a typed Layer, provided to `HttpApiBuilder.layer(api)`. Source: `effect/src/http-api/{HttpApiEndpoint,HttpApiBuilder}.ts`.
- The builder needs FileSystem/HttpPlatform/Path/Etag services. `HttpServer.layerServices` supplies them using `FileSystem.layerNoop({})`, Path, weak Etag and HttpPlatform, without a Node/Bun adapter (`effect/src/http/HttpServer.ts:395–405`). Suitable for JSON-only health; no filesystem support is promised. Alchemy's partial platform-stub example omits a required service; do not copy it.
- `HttpRouter.toHttpEffect(appLayer)` yields the request Effect once at construction. `HttpRouter.toWebHandler(appLayer)` returns `{ handler(Request): Promise<Response>, dispose(): Promise<void> }`; always await disposal in tests (`effect/src/http/HttpRouter.ts`).
- `Cloudflare.Worker(id, { main: import.meta.url }, Effect.gen(...))` returns `{ fetch }`; export that resource as the module default. `Alchemy.Stack(name, { providers: Cloudflare.providers(), state: Cloudflare.state() }, effect)` yields it and exposes `worker.url`. Sources: `alchemy/src/{Stack.ts,Cloudflare/Workers/Worker.ts}`.
- `Cloudflare.state()` resolves remote account state and may bootstrap the shared state Worker/DO/Secrets Store; it does not become local merely because dev mode is active (`alchemy/src/Cloudflare/StateStore/State.ts`). Its `loginWithCloudflare` is **not** profile OAuth: it uploads an auth-secret-reading edge preview and caches credentials. Unfinished local bootstrap resumes without a prompt; app plan's dry-run return does not prevent these state side effects. The public state Worker `/version` currently returns version 7; version/name alone do not establish ownership. Host adapters `@effect/platform-bun/node@4.0.3` follow Alchemy's getting-started dependencies and stay outside Worker code.
- Public health contract: `GET /health` → 200 JSON exactly `{"status":"ok"}`, liveness only; unknown paths 404. No auth policy for future application routes is implied.
- Pi project templates live in `.pi/prompts/*.md`; filename is the slash command, loaded after project trust; `/reload` refreshes. Verified Pi 1.1.0 `docs/{prompt-templates,configuration,security}.md`.

Update this file's facts and `docs/progress.md` with dated decisions and actual verification evidence at each milestone. A typecheck alone is never milestone completion.
