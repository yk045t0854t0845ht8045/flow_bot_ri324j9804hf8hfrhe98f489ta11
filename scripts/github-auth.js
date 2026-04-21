const { spawnSync } = require("node:child_process");
const https = require("node:https");
const path = require("node:path");
const fs = require("node:fs");

const rootDir = path.resolve(__dirname, "..");
const siteDir = path.join(rootDir, "site");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || rootDir,
    stdio: options.stdio || "pipe",
    encoding: "utf8",
  });

  return {
    status: typeof result.status === "number" ? result.status : 1,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

function runOrThrow(command, args, options = {}) {
  const result = run(command, args, {
    ...options,
    stdio: options.stdio || "inherit",
  });

  if (result.status !== 0) {
    const printable = `${command} ${args.join(" ")}`.trim();
    const output = result.stderr || result.stdout || "Falha ao autenticar no GitHub.";
    throw new Error(`${printable}: ${output}`);
  }

  return result;
}

function parseLines(value) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function resolveAuthProvider() {
  if (run("gh", ["--version"]).status === 0) {
    return "gh";
  }

  if (run("git", ["credential-manager", "--version"]).status === 0) {
    return "gcm";
  }

  return null;
}

function isGitRepository(targetDir) {
  return fs.existsSync(path.join(targetDir, ".git"));
}

function ensureGitCredentialManagerHelper() {
  const helpersResult = run("git", ["config", "--get-all", "credential.helper"]);
  const helpers = parseLines(helpersResult.stdout);
  if (helpers.some((helper) => helper.toLowerCase().includes("manager"))) {
    return;
  }

  runOrThrow("git", ["config", "--global", "credential.helper", "manager"]);
}

function listGitHubAccounts(provider = resolveAuthProvider()) {
  if (provider === "gh") {
    const result = run("gh", ["api", "user", "-q", ".login"]);
    if (result.status !== 0) {
      return [];
    }
    return parseLines(result.stdout);
  }

  if (provider === "gcm") {
    ensureGitCredentialManagerHelper();
    const result = run("git", ["credential-manager", "github", "list"]);
    if (result.status !== 0) {
      return [];
    }
    return parseLines(result.stdout);
  }

  return [];
}

function formatAccounts(accounts) {
  if (!accounts.length) {
    return "nenhuma conta";
  }

  return accounts.join(", ");
}

function getProviderDisplayName(provider) {
  if (provider === "gh") {
    return "GitHub CLI";
  }

  if (provider === "gcm") {
    return "Git Credential Manager";
  }

  return "GitHub";
}

function openGitHubLoginLauncher(provider = resolveAuthProvider()) {
  if (!provider) {
    throw new Error(
      "Nao encontrei GitHub CLI nem Git Credential Manager. Instale um deles para fazer login.",
    );
  }

  if (provider === "gh") {
    runOrThrow(
      "gh",
      ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web"],
      { stdio: "inherit" },
    );
    return;
  }

  ensureGitCredentialManagerHelper();
  runOrThrow(
    "git",
    ["credential-manager", "github", "login"],
    { stdio: "inherit" },
  );
}

function logoutGitHubAccounts(accounts, provider) {
  if (!accounts.length || !provider) {
    return;
  }

  if (provider === "gh") {
    accounts.forEach((account) => {
      runOrThrow(
        "gh",
        ["auth", "logout", "--hostname", "github.com", "--user", account, "--yes"],
        { stdio: "inherit" },
      );
    });
    return;
  }

  accounts.forEach((account) => {
    runOrThrow(
      "git",
      ["credential-manager", "github", "logout", account],
      { stdio: "inherit" },
    );
  });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "User-Agent": "flowdesk-github-auth",
          Accept: "application/vnd.github+json",
        },
      },
      (response) => {
        const chunks = [];

        response.on("data", (chunk) => {
          chunks.push(chunk);
        });

        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if (response.statusCode && response.statusCode >= 400) {
            reject(
              new Error(
                `GitHub API respondeu ${response.statusCode}: ${raw || "erro desconhecido"}`,
              ),
            );
            return;
          }

          try {
            resolve(JSON.parse(raw));
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    request.on("error", reject);
  });
}

async function fetchGitHubUserProfile(username) {
  return fetchJson(`https://api.github.com/users/${encodeURIComponent(username)}`);
}

function buildGitHubNoreplyEmail(profile) {
  const login = typeof profile?.login === "string" ? profile.login.trim() : "";
  const id = Number(profile?.id);

  if (login && Number.isFinite(id) && id > 0) {
    return `${id}+${login}@users.noreply.github.com`;
  }

  if (login) {
    return `${login}@users.noreply.github.com`;
  }

  throw new Error("Nao foi possivel montar o email noreply do GitHub.");
}

function setGitIdentity(target, input) {
  const args = target === "global"
    ? ["config", "--global"]
    : ["config"];

  runOrThrow("git", [...args, "user.name", input.name], {
    cwd: input.cwd || rootDir,
  });
  runOrThrow("git", [...args, "user.email", input.email], {
    cwd: input.cwd || rootDir,
  });
}

async function syncGitIdentityForGitHubAccount(account, options = {}) {
  if (!account) {
    throw new Error("Nenhuma conta GitHub foi informada para sincronizar a identidade.");
  }

  const profile = await fetchGitHubUserProfile(account);
  const gitName = profile.login || account;
  const gitEmail = buildGitHubNoreplyEmail(profile);

  setGitIdentity("global", {
    name: gitName,
    email: gitEmail,
  });

  if (isGitRepository(rootDir)) {
    setGitIdentity("local", {
      cwd: rootDir,
      name: gitName,
      email: gitEmail,
    });
  }

  if (isGitRepository(siteDir)) {
    setGitIdentity("local", {
      cwd: siteDir,
      name: gitName,
      email: gitEmail,
    });
  }

  if (options.showStatus !== false) {
    console.log(`Identidade Git sincronizada: ${gitName} <${gitEmail}>`);
  }

  return {
    profile,
    gitName,
    gitEmail,
  };
}

function ensureGitHubLogin(options = {}) {
  const provider = resolveAuthProvider();
  if (!provider) {
    throw new Error(
      "Nao encontrei GitHub CLI nem Git Credential Manager. Instale um deles para usar login/logout do GitHub.",
    );
  }

  const currentAccounts = listGitHubAccounts(provider);
  if (currentAccounts.length) {
    if (options.showStatus !== false) {
      console.log(
        `GitHub ja conectado via ${getProviderDisplayName(provider)}: ${formatAccounts(currentAccounts)}`,
      );
    }

    return {
      provider,
      accounts: currentAccounts,
      loginPerformed: false,
    };
  }

  console.log(
    `Nenhum login do GitHub encontrado. Abrindo o launcher de autenticacao via ${getProviderDisplayName(provider)}...`,
  );
  openGitHubLoginLauncher(provider);

  const nextAccounts = listGitHubAccounts(provider);
  if (!nextAccounts.length) {
    throw new Error("Login do GitHub nao foi concluido.");
  }

  if (options.showStatus !== false) {
    console.log(`GitHub conectado: ${formatAccounts(nextAccounts)}`);
  }

  return {
    provider,
    accounts: nextAccounts,
    loginPerformed: true,
  };
}

function logoutAndPromptGitHubLogin(options = {}) {
  const provider = resolveAuthProvider();
  if (!provider) {
    throw new Error(
      "Nao encontrei GitHub CLI nem Git Credential Manager. Instale um deles para usar login/logout do GitHub.",
    );
  }

  const currentAccounts = listGitHubAccounts(provider);
  if (currentAccounts.length) {
    console.log(`Removendo login atual do GitHub: ${formatAccounts(currentAccounts)}`);
    logoutGitHubAccounts(currentAccounts, provider);
  } else {
    console.log("Nenhuma conta GitHub conectada no momento.");
  }

  console.log("Abrindo o launcher para voce entrar novamente no GitHub...");
  openGitHubLoginLauncher(provider);

  const nextAccounts = listGitHubAccounts(provider);
  if (!nextAccounts.length) {
    throw new Error("Novo login do GitHub nao foi concluido.");
  }

  if (options.showStatus !== false) {
    console.log(`GitHub conectado novamente: ${formatAccounts(nextAccounts)}`);
  }

  return {
    provider,
    accounts: nextAccounts,
  };
}

module.exports = {
  ensureGitCredentialManagerHelper,
  ensureGitHubLogin,
  formatAccounts,
  listGitHubAccounts,
  logoutAndPromptGitHubLogin,
  resolveAuthProvider,
  syncGitIdentityForGitHubAccount,
};
