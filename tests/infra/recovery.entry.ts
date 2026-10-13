// Explicit file argument only; not named *.test.ts and never default-discovered.
import { test } from "bun:test";
import { loadChildContext } from "./files.ts";

try {
  const context = loadChildContext();
  if (context.run.recoveryFrom !== "22bfea207d84") throw new Error("invalid_recovery_registration");
  const { registerRecovery } = await import("./recovery-native.ts");
  registerRecovery(context);
} catch {
  test("exact-stage recovery registration", () => {
    throw new Error("invalid_recovery_registration");
  });
}
