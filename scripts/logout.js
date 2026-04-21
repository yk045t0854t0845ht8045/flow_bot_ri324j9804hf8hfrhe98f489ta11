const { logoutAndPromptGitHubLogin } = require("./github-auth");

function main() {
  console.log("\n=== Flowdesk GitHub Logout ===\n");
  logoutAndPromptGitHubLogin({ showStatus: true });
}

try {
  main();
} catch (error) {
  console.error(`\nErro ao sair do GitHub: ${error.message}`);
  process.exit(1);
}
