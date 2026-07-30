const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const installerPath = path.resolve(__dirname, "../hooks/install.js");
const uninstallerPath = path.resolve(__dirname, "../hooks/uninstall.js");
const updaterPath = path.resolve(__dirname, "../hooks/update.js");
const staleNode = "/opt/homebrew/Cellar/node/26.5.0/bin/node";
const nodePathPrefix =
  'PATH="/opt/homebrew/bin:/usr/local/bin${PATH:+:$PATH}" node ';

const runScript = (scriptPath, home) => {
  const script = [
    `require("node:child_process").execSync = () => {};`,
    `Object.defineProperty(process, "execPath", { value: process.env.MOCK_EXEC_PATH });`,
    `require(process.env.SCRIPT_PATH);`,
  ].join("\n");

  execFileSync(process.execPath, ["-e", script], {
    env: {
      ...process.env,
      HOME: home,
      SCRIPT_PATH: scriptPath,
      MOCK_EXEC_PATH: staleNode,
    },
    stdio: "pipe",
  });
};

const runInstaller = (home) => runScript(installerPath, home);
const runUninstaller = (home) => runScript(uninstallerPath, home);

const readSettings = (home) => {
  const settingsPath = path.join(home, ".claude", "settings.json");
  return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
};

const hookCommands = (settings) => {
  return Object.values(settings.hooks)
    .flat()
    .flatMap((entry) => entry.hooks || [])
    .map((hook) => hook.command || "");
};

const statusBarCommands = (settings) =>
  hookCommands(settings).filter((command) => command.startsWith(nodePathPrefix));

const shellQuote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
const shellDoubleQuote = (value) =>
  value.replace(/["\\`$]/g, (character) => `\\${character}`);

test("installs portable, quoted hook commands and replaces stale hooks", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude $`\"' status bar test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const claudeDir = path.join(home, ".claude");
  const settingsPath = path.join(claudeDir, "settings.json");
  const oldScript = path.join(claudeDir, "statusbar", "update.js");
  const unrelatedCommand = "echo keep-me";
  const original = {
    customSetting: true,
    hooks: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            { type: "command", command: `${staleNode} ${oldScript} pre` },
            { type: "command", command: unrelatedCommand },
            { type: "prompt" },
          ],
        },
      ],
      Notification: [{ matcher: "empty-entry" }],
    },
  };
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(original, null, 2));
  const oldAgentPlist = path.join(
    home,
    "Library",
    "LaunchAgents",
    "com.local.claudestatusbar.watcher.plist",
  );
  fs.mkdirSync(path.dirname(oldAgentPlist), { recursive: true });
  fs.writeFileSync(oldAgentPlist, "obsolete");

  runInstaller(home);

  const settings = readSettings(home);
  const allCommands = hookCommands(settings);
  const commands = statusBarCommands(settings);
  const updatePath = path.join(claudeDir, "statusbar", "update.js");
  const lifecyclePath = path.join(claudeDir, "statusbar", "lifecycle.js");
  const statuslinePath = path.join(claudeDir, "statusbar", "statusline.js");

  assert.equal(settings.customSetting, true);
  assert.equal(fs.existsSync(oldAgentPlist), false);
  assert.equal(commands.length, 8);
  assert.ok(commands.every((command) => command.startsWith(nodePathPrefix)));
  assert.ok(allCommands.every((command) => !command.includes(staleNode)));
  assert.ok(allCommands.every((command) => !command.includes(process.execPath)));
  assert.ok(commands.includes(`${nodePathPrefix}${shellQuote(updatePath)} pre`));
  assert.ok(commands.includes(`${nodePathPrefix}${shellQuote(lifecyclePath)} start`));
  assert.equal(settings.statusLine.command, `${nodePathPrefix}${shellQuote(statuslinePath)}`);
  assert.equal(settings.statusLine.refreshInterval, 30);

  const lifecycleEnd = commands.find((command) => command.endsWith(" end"));
  const fixtureBin = path.join(home, "minimal-bin");
  fs.mkdirSync(fixtureBin);
  fs.symlinkSync(process.execPath, path.join(fixtureBin, "node"));
  const statePath = path.join(
    claudeDir,
    "statusbar",
    "state.d",
    "quoted-path-test.json",
  );
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, "{}");
  const fixtureCommand = lifecycleEnd.replace(
    "/opt/homebrew/bin:/usr/local/bin",
    shellDoubleQuote(fixtureBin),
  );
  const noNodeEnvironment = {
    ...process.env,
    HOME: home,
    PATH: "",
  };
  assert.throws(() => {
    execFileSync("/bin/sh", ["-c", "command -v node"], {
      env: noNodeEnvironment,
      stdio: "pipe",
    });
  });
  execFileSync("/bin/sh", ["-c", fixtureCommand], {
    env: noNodeEnvironment,
    input: JSON.stringify({ session_id: "quoted-path-test" }),
    stdio: "pipe",
  });
  assert.equal(fs.existsSync(statePath), false);

  assert.equal(allCommands.filter((command) => command === unrelatedCommand).length, 1);
  assert.equal(
    settings.hooks.PreToolUse.flatMap((entry) => entry.hooks).filter(
      (hook) => hook.type === "prompt",
    ).length,
    1,
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(`${settingsPath}.bak-statusbar`, "utf8")),
    original,
  );

  const firstInstall = settings;
  runInstaller(home);
  assert.deepEqual(readSettings(home), firstInstall);

  runUninstaller(home);
  const uninstalled = readSettings(home);
  assert.equal(statusBarCommands(uninstalled).length, 0);
  assert.equal(uninstalled.statusLine, undefined);
  assert.equal(uninstalled.customSetting, true);
  assert.equal(
    uninstalled.hooks.PreToolUse.flatMap((entry) => entry.hooks).filter(
      (hook) => hook.command === unrelatedCommand,
    ).length,
    1,
  );
});

test("preserves an existing status line while collecting session metrics", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude status line test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const claudeDir = path.join(home, ".claude");
  const settingsPath = path.join(claudeDir, "settings.json");
  const originalStatusLine = {
    type: "command",
    command: "printf preserved",
    padding: 3,
    refreshInterval: 12,
  };
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({ statusLine: originalStatusLine }));

  runInstaller(home);

  const installed = readSettings(home);
  const statuslinePath = path.join(claudeDir, "statusbar", "statusline.js");
  assert.equal(installed.statusLine.command, `${nodePathPrefix}${shellQuote(statuslinePath)}`);
  assert.equal(installed.statusLine.padding, 3);
  assert.equal(installed.statusLine.refreshInterval, 12);

  const input = {
    session_id: "metrics-session",
    model: { id: "claude-sonnet-5", display_name: "Sonnet" },
    effort: { level: "xhigh" },
    rate_limits: {
      five_hour: { used_percentage: 34.5, resets_at: 2000000000 },
      seven_day: { used_percentage: 67.5, resets_at: 2000001000 },
    },
  };
  const output = execFileSync(process.execPath, [statuslinePath], {
    env: { ...process.env, HOME: home },
    input: JSON.stringify(input),
    encoding: "utf8",
  });
  assert.equal(output, "preserved");

  const metrics = JSON.parse(fs.readFileSync(
    path.join(claudeDir, "statusbar", "metrics.d", "metrics-session.json"),
    "utf8",
  ));
  assert.equal(metrics.model, "claude-sonnet-5");
  assert.equal(metrics.effort, "xhigh");
  assert.equal(metrics.fiveHourUsed, 34.5);
  assert.equal(metrics.weeklyUsed, 67.5);

  runUninstaller(home);
  assert.deepEqual(readSettings(home).statusLine, originalStatusLine);
});

test("stores model and effort from hook input", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude model effort test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const statusbarDir = path.join(home, ".claude", "statusbar");
  fs.mkdirSync(statusbarDir, { recursive: true });
  fs.writeFileSync(path.join(statusbarDir, "quit-intent"), "");
  execFileSync(process.execPath, [updaterPath, "pre"], {
    env: { ...process.env, HOME: home },
    input: JSON.stringify({
      session_id: "hook-session",
      cwd: home,
      transcript_path: "",
      tool_name: "Read",
      model: { id: "claude-opus-5", display_name: "Opus" },
      effort: { level: "high" },
    }),
    stdio: "pipe",
  });

  const state = JSON.parse(fs.readFileSync(
    path.join(statusbarDir, "state.d", "hook-session.json"),
    "utf8",
  ));
  assert.equal(state.model, "claude-opus-5");
  assert.equal(state.modelDisplay, "Opus");
  assert.equal(state.effort, "high");
});

test("reads model and effort from the session transcript", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude transcript metadata test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const statusbarDir = path.join(home, ".claude", "statusbar");
  const transcriptPath = path.join(home, "session.jsonl");
  fs.mkdirSync(statusbarDir, { recursive: true });
  fs.writeFileSync(path.join(statusbarDir, "quit-intent"), "");
  fs.writeFileSync(transcriptPath, JSON.stringify({
    type: "assistant",
    effort: "max",
    message: { model: "claude-fable-5" },
  }) + "\n");

  execFileSync(process.execPath, [updaterPath, "stop"], {
    env: { ...process.env, HOME: home },
    input: JSON.stringify({
      session_id: "transcript-session",
      cwd: home,
      transcript_path: transcriptPath,
    }),
    stdio: "pipe",
  });

  const state = JSON.parse(fs.readFileSync(
    path.join(statusbarDir, "state.d", "transcript-session.json"),
    "utf8",
  ));
  assert.equal(state.model, "claude-fable-5");
  assert.equal(state.effort, "max");
});

test("reinstalling is idempotent", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude status bar test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  runInstaller(home);
  const first = readSettings(home);
  runInstaller(home);
  const second = readSettings(home);

  assert.deepEqual(second, first);
  assert.equal(statusBarCommands(second).length, 8);
});

test("an empty inherited PATH never searches the working directory", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude status bar security test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  runInstaller(home);
  const lifecycleEnd = hookCommands(readSettings(home)).find(
    (command) => command.includes("lifecycle.js") && command.endsWith(" end"),
  );
  const hostileCwd = path.join(home, "hostile-project");
  const canaryPath = path.join(home, "cwd-node-ran");
  fs.mkdirSync(hostileCwd);
  fs.writeFileSync(
    path.join(hostileCwd, "node"),
    `#!/bin/sh\n: > ${shellQuote(canaryPath)}\nexit 0\n`,
  );
  fs.chmodSync(path.join(hostileCwd, "node"), 0o755);

  const missingFallbacks = [
    path.join(home, "missing-homebrew-bin"),
    path.join(home, "missing-local-bin"),
  ].join(":");
  const isolatedCommand = lifecycleEnd.replace(
    "/opt/homebrew/bin:/usr/local/bin",
    shellDoubleQuote(missingFallbacks),
  );

  assert.throws(
    () => {
      execFileSync("/bin/sh", ["-c", isolatedCommand], {
        cwd: hostileCwd,
        env: {
          ...process.env,
          HOME: home,
          PATH: "",
        },
        input: JSON.stringify({ session_id: "security-test" }),
        stdio: "pipe",
      });
    },
    (error) => error.status === 127,
  );
  assert.equal(fs.existsSync(canaryPath), false);
});
