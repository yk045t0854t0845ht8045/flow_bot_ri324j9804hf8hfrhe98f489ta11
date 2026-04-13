const { spawnSync } = require("node:child_process");
const readline = require("node:readline");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");

function run(command, args) {
  const printable = `${command} ${args.join(" ")}`;
  console.log(`\n> ${printable}`);

  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    shell: true,
  });

  if (result.status !== 0) {
    throw new Error(`Falha ao executar: ${printable}`);
  }
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: "pipe",
    encoding: "utf8",
    shell: true,
  });
  return (result.stdout || "").trim();
}

async function main() {
  console.log("🚀 Iniciando sincronização inteligente (npm run now)...");

  // 1. Verificar se há mudanças
  const status = capture("git", ["status", "--porcelain"]);
  const hasChanges = status.length > 0;

  if (hasChanges) {
    console.log("\n📦 Mudanças locais detectadas.");
    
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const commitMessage = await new Promise((resolve) => {
      rl.question("\n> O que você alterou? (Mensagem de commit): ", (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });

    const finalMessage = commitMessage || `update: ${new Date().toLocaleString("pt-BR")}`;

    try {
      run("git", ["add", "."]);
      run("git", ["commit", "-m", `"${finalMessage}"`]);
    } catch (error) {
      console.error("\n❌ Erro ao commitar as mudanças.");
      process.exit(1);
    }
  } else {
    console.log("\n✅ Nenhuma mudança local para commitar.");
  }

  // 2. Sincronizar com o remoto usando REBASE
  console.log("\n📡 Buscando atualizações da equipe (git pull --rebase)...");
  try {
    run("git", ["fetch", "origin"]);
    run("git", ["pull", "--rebase", "origin", "main"]);
  } catch (error) {
    console.error("\n⚠️ Houve um conflito ou erro ao puxar as atualizações.");
    console.error("Por favor, resolva os conflitos manualmente e depois use 'git add .' e 'git rebase --continue'.");
    process.exit(1);
  }

  // 3. Subir para o servidor
  console.log("\n⬆️ Subindo suas atualizações...");
  try {
    run("git", ["push", "origin", "main"]);
    console.log("\n✅ Tudo pronto! Seu código está sincronizado e seguro.");
  } catch (error) {
    console.error("\n❌ Erro ao subir o código para o GitHub.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\n💥 Erro inesperado: ${err.message}`);
  process.exit(1);
});
