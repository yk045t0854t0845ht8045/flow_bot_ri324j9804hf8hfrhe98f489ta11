const { spawnSync } = require("node:child_process");
const readline = require("node:readline");
const path = require("node:path");
const fs = require("node:fs");

const rootDir = path.resolve(__dirname, "..");
const DEFAULT_SITE_GITHUB_REMOTE =
  "https://github.com/Flowdesk-Brasil/Fl0wD3sk_845983_wjcwf0328roifldvn_934320fn02rg0g89.git";
const DEFAULT_BOT_GITHUB_REMOTE =
  "https://github.com/Flowdesk-Brasil/flow_bot_ri324j9804hf8hfrhe98f489ta11.git";

/**
 * Executa um comando e joga o output no terminal atual.
 */
function run(command, args, cwd = rootDir) {
  const relPath = path.relative(rootDir, cwd) || ".";
  const printable = `${command} ${args.join(" ")}`;
  console.log(`\n[${relPath}] > ${printable}`);

  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: true,
  });

  if (result.status !== 0) {
    throw new Error(`Falha ao executar em ${relPath}: ${printable}`);
  }
}

/**
 * Executa um comando e captura o output sem falhar o script.
 */
function capture(command, args, cwd = rootDir) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "pipe",
    encoding: "utf8",
    shell: true,
  });
  return (result.stdout || "").trim();
}

/**
 * Pergunta ao usuário uma mensagem de commit.
 */
async function askCommitMessage(repoName, rl) {
  return new Promise((resolve) => {
    rl.question(`\n📦 Mudanças detectadas em [${repoName}].\n> O que você alterou? (Mensagem de commit): `, (answer) => {
      resolve(answer.trim());
    });
  });
}

function ensureRemoteOrigin(targetDir, repoName, remoteUrl) {
  if (!remoteUrl) {
    return;
  }

  const currentOrigin = capture("git", ["remote", "get-url", "origin"], targetDir);
  if (currentOrigin === remoteUrl) {
    return;
  }

  const remoteList = capture("git", ["remote"], targetDir)
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);

  if (remoteList.includes("origin")) {
    console.log(`\n🔁 Atualizando remote [${repoName}] para o repositorio novo...`);
    run("git", ["remote", "set-url", "origin", remoteUrl], targetDir);
    return;
  }

  console.log(`\n🔗 Configurando remote [${repoName}]...`);
  run("git", ["remote", "add", "origin", remoteUrl], targetDir);
}

/**
 * Verifica se o repositório está em meio a um merge ou rebase (conflito).
 */
function isResolvingConflict(targetDir) {
  const gitDir = path.join(targetDir, ".git");
  return (
    fs.existsSync(path.join(gitDir, "MERGE_HEAD")) ||
    fs.existsSync(path.join(gitDir, "rebase-merge")) ||
    fs.existsSync(path.join(gitDir, "rebase-apply")) ||
    fs.existsSync(path.join(gitDir, "BISECT_LOG"))
  );
}

/**
 * Lógica principal de sincronização de um repositório git.
 */
async function syncRepo(targetDir, repoName, rl, options = {}) {
  if (!fs.existsSync(path.join(targetDir, ".git"))) {
    console.log(`\nℹ️  Pulando [${repoName}]: não é um repositório Git.`);
    return;
  }

  const relPath = path.relative(rootDir, targetDir) || ".";
  ensureRemoteOrigin(targetDir, repoName, options.remoteUrl || null);

  // 0. Verificar se já existe um conflito pendente
  if (isResolvingConflict(targetDir)) {
    console.log(`\n⚠️  [${repoName}] já está com um conflito pendente!`);
    console.log(`   Por favor, resolva os conflitos no VS Code, dê um 'git add .' e depois:`);
    console.log(`   - 'git rebase --continue' ou 'git commit'`);
    throw new Error(`Conflito pendente em ${repoName}`);
  }

  // 1. Pre-flight Check: Fetch remote
  console.log(`\n📡 Verificando atualizações no GitHub para [${repoName}]...`);
  try {
    run("git", ["fetch", "origin"], targetDir);
  } catch (err) {
    console.warn(`\n⚠️  Aviso: Não foi possível conectar ao GitHub para [${repoName}]. Tentando continuar...`);
  }

  const branch = capture("git", ["rev-parse", "--abbrev-ref", "HEAD"], targetDir) || "main";

  // 2. Verificar mudanças locais
  console.log(`\n🔍 Verificando mudanças locais em [${repoName}]...`);
  const status = capture("git", ["status", "--porcelain"], targetDir);
  const hasChanges = status.length > 0;

  if (hasChanges) {
    const commitMessage = await askCommitMessage(repoName, rl);
    const finalMessage = commitMessage || `update: ${new Date().toLocaleString("pt-BR")}`;

    try {
      run("git", ["add", "."], targetDir);
      run("git", ["commit", "-m", `"${finalMessage}"`], targetDir);
    } catch (error) {
      console.error(`\n❌ Erro ao salvar mudanças em [${repoName}].`);
      throw error;
    }
  } else {
    console.log(`\n✅ Nenhuma mudança local em [${repoName}].`);
  }

  // 3. Puxar atualizações (REBASE SEGURO)
  console.log(`\n📡 Sincronizando com o GitHub [${repoName}]...`);
  try {
    // Usamos pull --rebase para manter o histórico limpo.
    // Mas envolvemos em um try/catch para fazer o abort automático se falhar.
    const pullResult = spawnSync("git", ["pull", "--rebase", "origin", branch], {
      cwd: targetDir,
      stdio: "inherit",
      shell: true,
    });

    if (pullResult.status !== 0) {
      console.warn(`\n⚠️  CONFLITO DETECTADO ao sincronizar [${repoName}]!`);
      console.log(`   Revertendo para o estado seguro anterior (git rebase --abort)...`);
      
      spawnSync("git", ["rebase", "--abort"], { cwd: targetDir });
      
      console.log(`\n❌ A sincronização de [${repoName}] foi cancelada.`);
      console.log(`   MOTIVO: Alguém alterou o mesmo arquivo que você no GitHub.`);
      console.log(`   COMO RESOLVER:`);
      console.log(`   1. Vá na pasta '${relPath}'`);
      console.log(`   2. Digite: git pull --rebase origin ${branch}`);
      console.log(`   3. Resolva os conflitos que o Git marcar nos arquivos.`);
      console.log(`   4. Digite: git add .`);
      console.log(`   5. Digite: git rebase --continue`);
      console.log(`   6. Rode o 'npm run now' de novo.`);
      
      throw new Error(`Conflito de sincronização em ${repoName}`);
    }
  } catch (error) {
    throw error;
  }

  // 4. Subir para o servidor
  console.log(`\n⬆️  Subindo [${repoName}] para o GitHub...`);
  try {
    run("git", ["push", "origin", branch], targetDir);
    console.log(`\n✨ [${repoName}] sincronizado e salvo com sucesso!`);
  } catch (error) {
    console.error(`\n❌ Erro ao enviar código de [${repoName}] para o servidor.`);
    console.log(`   Isso pode ser falta de internet ou permissão.`);
    throw error;
  }
}

async function main() {
  console.log("\n🚀 ==================================================");
  console.log("🚀 BULLTEPROOF SYNC (npm run now)");
  console.log("🚀 ==================================================\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const siteDir = path.join(rootDir, "site");
    if (fs.existsSync(siteDir)) {
      await syncRepo(siteDir, "SITE / DASHBOARD", rl, {
        remoteUrl: process.env.SITE_GITHUB_REMOTE || DEFAULT_SITE_GITHUB_REMOTE,
      });
    }

    await syncRepo(rootDir, "BOT / CORE", rl, {
      remoteUrl: process.env.BOT_GITHUB_REMOTE || DEFAULT_BOT_GITHUB_REMOTE,
    });

    console.log("\n🎉 ==================================================");
    console.log("🎉 SUCESSO! Todo o seu código está no GitHub.");
    console.log("🎉 ==================================================\n");
  } catch (error) {
    if (!error.message.includes("Conflito de sincronização")) {
      console.error(`\n💥 ERRO CRÍTICO: ${error.message}`);
    }
    console.log("\n⚠️ A sincronização foi interrompida com segurança.");
    process.exit(1);
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(`\n💥 Erro inesperado: ${err.message}`);
  process.exit(1);
});
