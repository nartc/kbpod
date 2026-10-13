import { describe, expect, test } from "bun:test";
import { runSmoke } from "../scripts/smoke.ts";
import { HealthCheckError, formatHealthFailure } from "./health-check.ts";

const origin = "https://kbpod.test";
const secret = "fixture-secret-never-print";
const json = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { "content-type": `application/json; private=${secret}` },
  });

const failures: [string, () => Response, string][] = [
  [
    "503 JSON",
    () => json(`{"token":"${secret}"}`, 503),
    "reason=http_status status=503 contentType=json",
  ],
  [
    "403 HTML",
    () =>
      new Response(secret, {
        status: 403,
        headers: { "content-type": `text/html; private=${secret}` },
      }),
    "reason=http_status status=403 contentType=html",
  ],
  [
    "404 text",
    () => new Response(secret, { status: 404, headers: { "content-type": "text/plain" } }),
    "reason=http_status status=404 contentType=text",
  ],
  [
    "redirect",
    () => new Response(null, { status: 302, headers: { location: `https://${secret}.test` } }),
    "reason=http_status status=302 contentType=missing",
  ],
  [
    "wrong media",
    () => new Response('{"status":"ok"}', { headers: { "content-type": `application/${secret}` } }),
    "reason=content_type status=200 contentType=other",
  ],
  [
    "missing media",
    () => new Response(new TextEncoder().encode('{"status":"ok"}')),
    "reason=content_type status=200 contentType=missing",
  ],
  ["malformed JSON", () => json(`{${secret}`), "reason=invalid_json status=200 contentType=json"],
  [
    "wrong status value",
    () => json(`{"status":"${secret}"}`),
    "reason=schema_mismatch status=200 contentType=json",
  ],
  [
    "missing status",
    () => json(`{"${secret}":true}`),
    "reason=schema_mismatch status=200 contentType=json",
  ],
  ["null", () => json("null"), "reason=schema_mismatch status=200 contentType=json"],
  ["array", () => json('[{"status":"ok"}]'), "reason=schema_mismatch status=200 contentType=json"],
  [
    "extra fields",
    () => json(`{"status":"ok","${secret}":"${secret}"}`),
    "reason=unexpected_fields status=200 contentType=json",
  ],
  [
    "trailing body",
    () => json(`{"status":"ok"}${secret}`),
    "reason=invalid_json status=200 contentType=json",
  ],
];

describe("offline smoke diagnostics", () => {
  test("importing the CLI is quiet and does not run main", async () => {
    const moduleUrl = new URL("../scripts/smoke.ts", import.meta.url).href;
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `await import(${JSON.stringify(moduleUrl)}); console.log("import-inert");`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("import-inert");
    expect(stderr).toBe("");
  });

  test("real CLI emits safe stderr and nonzero exit for invalid input without a request", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        new URL("../scripts/smoke.ts", import.meta.url).pathname,
        `https://user:${secret}@kbpod.test`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr.trim()).toBe("Health verification failed: reason=invalid_url");
    expect(stderr).not.toContain(secret);
  });

  test.each(failures)(
    "reports safe details for %s without retry",
    async (_label, response, expected) => {
      let calls = 0;
      const result = await runSmoke([origin], async (url, options) => {
        calls++;
        expect(url.href).toBe(`${origin}/health`);
        expect(options.redirect).toBe("error");
        expect(options.headers).toBeUndefined();
        expect(options.method ?? "GET").toBe("GET");
        expect(options.signal).toBeInstanceOf(AbortSignal);
        return response();
      });
      expect(calls).toBe(1);
      expect(result).toEqual({ exitCode: 1, message: `Health verification failed: ${expected}` });
      expect(result.message).not.toContain(secret);
    },
  );

  test.each(['{"status":"ok"}', ' \n{ "status": "ok" }\n'])(
    "preserves exact-contract success with JSON whitespace/parameters: %s",
    async (body) => {
      let calls = 0;
      const result = await runSmoke(["--", origin], async () => {
        calls++;
        return json(body);
      });
      expect(calls).toBe(1);
      expect(result).toEqual({
        exitCode: 0,
        message: `Health verified: ${origin}/health — 200 application/json {"status":"ok"}`,
      });
    },
  );

  test.each([
    [[], "usage"],
    [[origin, secret], "usage"],
    [[secret], "invalid_url"],
    [[`https://user:${secret}@kbpod.test`], "invalid_url"],
    [[`${origin}/?token=${secret}`], "invalid_url"],
    [[`${origin}/#${secret}`], "invalid_url"],
    [[`${origin}/${secret}`], "invalid_url"],
    [[`ftp://${secret}.test`], "invalid_url"],
  ] as [string[], string][])("rejects unsafe input without fetching: %j", async (args, reason) => {
    let calls = 0;
    const result = await runSmoke(args, async () => {
      calls++;
      return json('{"status":"ok"}');
    });
    expect(calls).toBe(0);
    expect(result).toEqual({
      exitCode: 1,
      message: `Health verification failed: reason=${reason}`,
    });
    expect(result.message).not.toContain(secret);
  });

  test.each([
    [new DOMException(secret, "TimeoutError"), "timeout", "timeout"],
    [Object.assign(new Error(secret), { code: "ENOTFOUND" }), "transport", "dns"],
    [new Error(secret, { cause: { code: "CERT_HAS_EXPIRED", secret } }), "transport", "tls"],
    [Object.assign(new Error(secret), { code: "ECONNRESET" }), "transport", "connection"],
    [new Error(secret, { cause: { code: secret } }), "transport", "other"],
    [secret, "transport", "other"],
  ])("classifies transport without echoing errors: %#", async (error, reason, category) => {
    let calls = 0;
    const result = await runSmoke([origin], async () => {
      calls++;
      throw error;
    });
    expect(calls).toBe(1);
    expect(result).toEqual({
      exitCode: 1,
      message: `Health verification failed: reason=${reason} transport=${category}`,
    });
    expect(result.message).not.toContain(secret);
  });

  test("body timeout retains the received status and safe category", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new DOMException(secret, "TimeoutError"));
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
    const result = await runSmoke([origin], async () => response);
    expect(result).toEqual({
      exitCode: 1,
      message:
        "Health verification failed: reason=timeout status=200 contentType=json transport=timeout",
    });
  });

  test("unexpected failures and forged diagnostic fields cannot dump arbitrary data", async () => {
    expect(formatHealthFailure(new Error(secret, { cause: secret }))).toBe(
      "Health verification failed: reason=unexpected",
    );
    const forged = Object.assign(new HealthCheckError("http_status"), {
      details: { status: secret, contentType: secret, transport: secret },
      message: secret,
    });
    expect(formatHealthFailure(forged)).toBe("Health verification failed: reason=http_status");
    expect(
      formatHealthFailure(Object.assign(new HealthCheckError("unexpected"), { details: null })),
    ).toBe("Health verification failed: reason=unexpected");
    const hostile = new HealthCheckError("unexpected");
    Object.defineProperty(hostile, "reason", {
      get() {
        throw new Error(secret);
      },
    });
    expect(formatHealthFailure(hostile)).toBe("Health verification failed: reason=unexpected");
    expect(
      formatHealthFailure(Object.assign(new HealthCheckError("unexpected"), { reason: secret })),
    ).toBe("Health verification failed: reason=unexpected");
    const response = json('{"status":"ok"}');
    Object.defineProperty(response, "status", {
      get() {
        throw new Error(secret);
      },
    });
    expect(await runSmoke([origin], async () => response)).toEqual({
      exitCode: 1,
      message: "Health verification failed: reason=unexpected",
    });
  });
});
