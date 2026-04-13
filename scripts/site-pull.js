const { existsSync } = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

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

function ensureGitRepository() {
  if (!existsSync(path.join(siteDir, ".git"))) {
    run("git", ["init"]);
  }

  run("git", ["branch", "-M", "main"]);

  const remotes = captureOrEmpty("git", ["remote"])
    .split(/\r?\n/)
    .filter(Boolean);

  if (remotes.includes("origin")) {
    run("git", ["remote", "set-url", "origin", repoUrl]);
  } else {
    run("git", ["remote", "add", "origin", repoUrl]);
  }

  const configuredName = captureOrEmpty("git", ["config", "--get", "user.name"]);
  const configuredEmail = captureOrEmpty("git", ["config", "--get", "user.email"]);

  if (!configuredName) {
    run("git", ["config", "user.name", gitUserName]);
  }

  if (!configuredEmail) {
    run("git", ["config", "user.email", gitUserEmail]);
  }
}

function hasLocalChanges() {
  const result = spawnSync("git", ["status", "--porcelain"], {
    cwd: siteDir,
    stdio: "pipe",
    encoding: "utf8",
    shell: false,
  });

  if (result.status !== 0) {
    throw new Error("Falha ao verificar mudancas locais.");
  }

  return (result.stdout || "").trim().length > 0;
}

function syncFromGithub() {
  ensureGitRepository();

  const hadLocalChanges = hasLocalChanges();

  if (hadLocalChanges) {
    console.log("\nMudancas locais detectadas. Salvando temporariamente com git stash...");
    run("git", ["stash", "push", "-u", "-m", "site-pull-auto-stash"]);
  }

  try {
    run("git", ["fetch", "origin"]);
    run("git", ["pull", "--rebase", "origin", "main"]);
  } catch (error) {
    console.error("\nErro ao puxar atualizacoes do GitHub.");

    if (hadLocalChanges) {
      console.log("\nTentando restaurar suas mudancas locais...");
      try {
        run("git", ["stash", "pop"]);
      } catch (stashError) {
        console.error(
          "\nNao foi possivel aplicar o stash automaticamente. Verifique com: git stash list"
        );
      }
    }

    throw error;
  }

  if (hadLocalChanges) {
    console.log("\nReaplicando suas mudancas locais...");
    try {
      run("git", ["stash", "pop"]);
    } catch (error) {
      console.error(
        "\nHouve conflito ao reaplicar suas mudancas. Resolva os conflitos e depois rode git add ."
      );
      throw error;
    }
  }

  console.log("\nCodigo local atualizado com sucesso.");
}

try {
  syncFromGithub();
} catch (error) {
  console.error(`\nErro ao puxar o site: ${error.message}`);
  process.exit(1);
}