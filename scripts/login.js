const { ensureGitHubLogin } = require("./github-auth");

function main() {
  console.log("\n=== Flowdesk GitHub Login ===\n");
  ensureGitHubLogin({ showStatus: true });
}

try {
  main();
} catch (error) {
  console.error(`\nErro ao entrar no GitHub: ${error.message}`);
  process.exit(1);
}
