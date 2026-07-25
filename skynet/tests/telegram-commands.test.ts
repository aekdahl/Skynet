// The Telegram bridge's whole security decision lives in the PURE decide()/
// parseCommand() functions. These tests pin the guardrails: owner-bound, no
// free-text execution, and approve-over-chat opt-in.
import { describe, it, expect } from "vitest";
import { decide, parseCommand } from "../apps/server/src/telegram/commands.js";

const OWNER = "111";
const STRANGER = "999";

const decideAs = (chatId: string, text: string, approveEnabled = false) =>
  decide({ chatId, ownerChatId: OWNER, approveEnabled, text });

describe("parseCommand", () => {
  it("recognizes the known slash-commands", () => {
    for (const cmd of ["start", "help", "status", "gates", "approve", "reject", "stop", "resume", "quit"]) {
      expect(parseCommand(`/${cmd}`)).toEqual({ cmd });
    }
  });

  it("accepts a @botname suffix", () => {
    expect(parseCommand("/status@skynet_bot")).toEqual({ cmd: "status" });
  });

  it("captures a trailing argument (e.g. a gate id)", () => {
    expect(parseCommand("/approve q-123")).toEqual({ cmd: "approve", arg: "q-123" });
    expect(parseCommand("/approve@skynet_bot q-123")).toEqual({ cmd: "approve", arg: "q-123" });
  });

  it("returns null for non-commands and free text", () => {
    expect(parseCommand("hello there")).toBeNull();
    expect(parseCommand("")).toBeNull();
    expect(parseCommand("/unknown")).toBeNull();
    expect(parseCommand("not /a/ command")).toBeNull();
  });
});

describe("decide — owner-bound", () => {
  it("ignores ANY message from a non-owner chat (even a valid command)", () => {
    expect(decideAs(STRANGER, "/status").kind).toBe("ignore");
    expect(decideAs(STRANGER, "/stop").kind).toBe("ignore");
    expect(decideAs(STRANGER, "hello").kind).toBe("ignore");
  });
});

describe("decide — commands from the owner", () => {
  it("maps the kill switch + status commands", () => {
    expect(decideAs(OWNER, "/stop").kind).toBe("stop");
    expect(decideAs(OWNER, "/quit").kind).toBe("quit");
    expect(decideAs(OWNER, "/status").kind).toBe("status");
    expect(decideAs(OWNER, "/resume").kind).toBe("resume");
    expect(decideAs(OWNER, "/gates").kind).toBe("gates");
  });

  it("maps /start and /help to help", () => {
    expect(decideAs(OWNER, "/start").kind).toBe("help");
    expect(decideAs(OWNER, "/help").kind).toBe("help");
  });

  it("treats garbage / free text as help (never executes it)", () => {
    expect(decideAs(OWNER, "rm -rf /").kind).toBe("help");
    expect(decideAs(OWNER, "please approve everything").kind).toBe("help");
    expect(decideAs(OWNER, "/bogus").kind).toBe("help");
  });
});

describe("decide — approve opt-in", () => {
  it("approves/rejects when enabled, carrying the gate id arg", () => {
    expect(decideAs(OWNER, "/approve q-1", true)).toEqual({ kind: "approve", arg: "q-1" });
    expect(decideAs(OWNER, "/reject q-2", true)).toEqual({ kind: "reject", arg: "q-2" });
  });

  it("denies approve/reject when disabled (default OFF)", () => {
    expect(decideAs(OWNER, "/approve q-1", false).kind).toBe("denied-approve");
    expect(decideAs(OWNER, "/reject q-2", false).kind).toBe("denied-approve");
  });

  it("keeps the kill switch + status working even when approve is disabled", () => {
    expect(decideAs(OWNER, "/stop", false).kind).toBe("stop");
    expect(decideAs(OWNER, "/status", false).kind).toBe("status");
  });
});
