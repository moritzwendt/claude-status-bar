#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const dir = path.join(os.homedir(), ".claude", "statusbar");
const metricsDir = path.join(dir, "metrics.d");
const originalPath = path.join(dir, "statusline-original.json");
const safeId = (value) =>
  String(value || "").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64) || "unknown";

let raw = "";
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  let input = {};
  try { input = JSON.parse(raw || "{}"); } catch {}

  const id = safeId(input.session_id);
  const model = input.model || {};
  const effort = input.effort || {};
  const limits = input.rate_limits || {};
  const fiveHour = limits.five_hour || {};
  const weekly = limits.seven_day || {};
  const output = {
    sessionId: id,
    model: model.id || "",
    modelDisplay: model.display_name || "",
    effort: effort.level || "",
    fiveHourUsed: typeof fiveHour.used_percentage === "number" ? fiveHour.used_percentage : null,
    fiveHourResetsAt: typeof fiveHour.resets_at === "number" ? fiveHour.resets_at : null,
    weeklyUsed: typeof weekly.used_percentage === "number" ? weekly.used_percentage : null,
    weeklyResetsAt: typeof weekly.resets_at === "number" ? weekly.resets_at : null,
    ts: Math.floor(Date.now() / 1000),
  };

  try {
    fs.mkdirSync(metricsDir, { recursive: true });
    const target = path.join(metricsDir, id + ".json");
    const temporary = target + "." + process.pid + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(output));
    fs.renameSync(temporary, target);
    if (output.fiveHourUsed !== null || output.weeklyUsed !== null) {
      const usageTarget = path.join(dir, "usage.json");
      const usageTemporary = usageTarget + "." + process.pid + ".tmp";
      fs.writeFileSync(usageTemporary, JSON.stringify(output));
      fs.renameSync(usageTemporary, usageTarget);
    }
  } catch {}

  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(originalPath, "utf8")); } catch {}
  const original = saved.present ? saved.value : null;
  if (!original || original.type !== "command" || !original.command) return;

  let child;
  try {
    child = cp.spawn("/bin/sh", ["-c", original.command], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return;
  }
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.stdin.end(raw);
  child.on("close", (code) => process.exit(code || 0));
});
