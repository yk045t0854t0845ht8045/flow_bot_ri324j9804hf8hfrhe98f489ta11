const {
  ensureGitHubLogin,
  syncGitIdentityForGitHubAccount,
} = require("./github-auth");

async function main() {
  console.log("\n=== Flowdesk GitHub Login ===\n");
  const authSession = ensureGitHubLogin({ showStatus: true });
  await syncGitIdentityForGitHubAccount(authSession.accounts[0], {
    showStatus: true,
  });
}

main().catch((error) => {
  console.error(`\nErro ao entrar no GitHub: ${error.message}`);
  process.exit(1);
});
