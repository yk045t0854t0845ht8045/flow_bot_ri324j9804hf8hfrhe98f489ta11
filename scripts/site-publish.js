const { existsSync } = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const readline = require("node:readline");

const siteDir = path.resolve(__dirname, "..", "site");
const repoUrl =
  process.env.SITE_GITHUB_REMOTE ||
  "https://github.com/yk045t0854t0845ht8045/Fl0wD3sk_845983_wjcwf0328roifldvn_934320fn02rg0g89.git";
const gitUserName = process.env.SITE_GIT_NAME || "Flowdesk Site Bot";
const gitUserEmail =
  process.env.SITE_GIT_EMAIL || "flowdesk-site-bot@users.noreply.github.com";

if (!existsSync(siteDir)) {
  console.error("Pasta /site nao encontrada.");
  process.exit(1);
}

function run(command, args, options = {}) {
  let resolvedCommand = command;
  let resolvedArgs = args;

  if (process.platform === "win32" && command === "npm") {
    resolvedCommand = "cmd.exe";
    resolvedArgs = ["/d", "/s", "/c", `npm ${args.join(" ")}`];
  }

  const printable = `${command} ${args.join(" ")}`.trim();
  console.log(`\n> ${printable}`);

  const result = spawnSync(resolvedCommand, resolvedArgs, {
    cwd: siteDir,
    stdio: "inherit",
    shell: false,
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`Falha ao executar: ${printable}`);
  }
}

function capture(command, args) {
  const resolvedCommand =
    process.platform === "win32" && command === "npm" ? "npm.cmd" : command;

  const result = spawnSync(resolvedCommand, args, {
    cwd: siteDir,
    stdio: "pipe",
    encoding: "utf8",
    shell: false,
  });

  if (result.status !== 0) {
    throw new Error(`Falha ao executar: ${command} ${args.join(" ")}`);
  }

  return (result.stdout || "").trim();
}

function captureOrEmpty(command, args) {
  const result = spawnSync(command, args, {
    cwd: siteDir,
    stdio: "pipe",
    encoding: "utf8",
    shell: false,
  });

  if (result.status !== 0) {
    return "";
  }

  return (result.stdout || "").trim();
}

function hasStagedChanges() {
  const result = spawnSync("git", ["diff", "--cached", "--quiet"], {
    cwd: siteDir,
    shell: false,
  });

  return result.status === 1;
}

function ensureGitRepository() {
  if (!existsSync(path.join(siteDir, ".git"))) {
    run("git", ["init"]);
  }

  run("git", ["branch", "-M", "main"]);

  const remotes = capture("git", ["remote"])
    .split(/\r?\n/)
    .filter(Boolean);

  if (remotes.includes("origin")) {
    run("git", ["remote", "set-url", "origin", repoUrl]);
  } else {
    run("git", ["remote", "add", "origin", repoUrl]);
  }

  const configuredName = captureOrEmpty("git", ["config", "--get", "user.name"]);
  const configuredEmail = captureOrEmpty("git", [
    "config",
    "--get",
    "user.email",
  ]);

  if (!configuredName) {
    run("git", ["config", "user.name", gitUserName]);
  }

  if (!configuredEmail) {
    run("git", ["config", "user.email", gitUserEmail]);
  }
}

function askCommitMessage() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question("\n> Motivo do commit: ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function commitAndPush() {
  run("git", ["add", "."]);

  if (hasStagedChanges()) {
    let commitMessage = process.env.SITE_COMMIT_MESSAGE;

    if (!commitMessage) {
      commitMessage = await askCommitMessage();
    }

    if (!commitMessage) {
      commitMessage = `site: update ${new Date().toISOString()}`;
    }

    run("git", ["commit", "-m", commitMessage]);
  } else {
    console.log("\nNenhuma mudanca nova para commit no /site.");
  }

  run("git", ["push", "-u", "origin", "main"]);
}

async function publishSite() {
  run("npm", ["run", "build"]);
  ensureGitRepository();
  await commitAndPush();
  console.log("\nSite publicado com sucesso.");
}

(async () => {
  try {
    await publishSite();
  } catch (error) {
    console.error(`\nErro ao publicar o site: ${error.message}`);
    process.exit(1);
  }
})();
