// Operator seed policy — the production login blocker (kill the shared demo
// accounts in prod; seed the first admin from explicit env only).
//
// The demo pair (jordan/kyle, pw "skynet") is convenient for local dev but is a
// footgun on a hosted deploy: a well-known credential that can log in. So the
// seed policy must NEVER emit it outside dev/test, and must seed a real admin
// only from operator-provided credentials.
import { describe, it, expect } from "vitest";
import { MemoryOperatorDirectory, seedOperatorRecords } from "../apps/server/src/auth/operators.js";
import { DEFAULT_WORKSPACE } from "@skynet/shared";

describe("operator seed policy", () => {
  it("dev/test seeds the demo pair (login demoable end-to-end)", () => {
    const dir = new MemoryOperatorDirectory(seedOperatorRecords({ devMode: true }));
    expect(dir.verify("jordan@cyberdyne.dev", "skynet")).toEqual({
      workspaceId: DEFAULT_WORKSPACE,
      operatorId: "jordan",
    });
    expect(dir.verify("kyle@resistance.dev", "skynet")?.workspaceId).toBe("resistance");
  });

  it("production NEVER seeds the demo accounts", () => {
    const records = seedOperatorRecords({ devMode: false });
    expect(records).toHaveLength(0);
    const dir = new MemoryOperatorDirectory(records);
    // The well-known demo credential must not authenticate on a prod build.
    expect(dir.verify("jordan@cyberdyne.dev", "skynet")).toBeUndefined();
  });

  it("production seeds a single admin ONLY from explicit credentials", () => {
    const dir = new MemoryOperatorDirectory(
      seedOperatorRecords({
        devMode: false,
        adminEmail: "Admin@YourCo.com",
        adminPassword: "s3cret-pw",
        adminWorkspace: "acme",
      }),
    );
    // Email is matched case-insensitively; the given password + workspace apply.
    expect(dir.verify("admin@yourco.com", "s3cret-pw")).toEqual({
      workspaceId: "acme",
      operatorId: "admin",
    });
    // Wrong password is rejected; demo creds still don't work.
    expect(dir.verify("admin@yourco.com", "skynet")).toBeUndefined();
    expect(dir.verify("jordan@cyberdyne.dev", "skynet")).toBeUndefined();
  });

  it("admin defaults to the default workspace when none is given", () => {
    const records = seedOperatorRecords({ devMode: false, adminEmail: "a@b.co", adminPassword: "pw" });
    expect(records[0].workspaceId).toBe(DEFAULT_WORKSPACE);
  });

  it("an admin email without a password does NOT seed (both required)", () => {
    expect(seedOperatorRecords({ devMode: false, adminEmail: "a@b.co" })).toHaveLength(0);
    expect(seedOperatorRecords({ devMode: false, adminPassword: "pw" })).toHaveLength(0);
  });
});
