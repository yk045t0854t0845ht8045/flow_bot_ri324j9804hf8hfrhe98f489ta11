$ErrorActionPreference = "Stop"

$rootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$gitSafeDirectory = $rootDir -replace "\\", "/"
$repoUrl = if ($env:BOT_GITHUB_REMOTE) {
  $env:BOT_GITHUB_REMOTE
} else {
  "https://github.com/yk045t0854t0845ht8045/flow_bot_ri324j9804hf8hfrhe98f489ta11.git"
}
$gitUserName = if ($env:BOT_GIT_NAME) {
  $env:BOT_GIT_NAME
} else {
  "Flowdesk Bot Publisher"
}
$gitUserEmail = if ($env:BOT_GIT_EMAIL) {
  $env:BOT_GIT_EMAIL
} else {
  "flowdesk-bot-publisher@users.noreply.github.com"
}
$excludedPaths = @("site", "tmp", ".env")

function Invoke-Git {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments
  )

  $printable = "git -c safe.directory=$gitSafeDirectory $($Arguments -join " ")"
  Write-Host ""
  Write-Host "> $printable"

  & git "-c" "safe.directory=$gitSafeDirectory" @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Falha ao executar: $printable"
  }
}

function Get-GitOutput {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments
  )

  $output = & git "-c" "safe.directory=$gitSafeDirectory" @Arguments 2>$null
  if ($LASTEXITCODE -ne 0) {
    throw "Falha ao executar: git -c safe.directory=$gitSafeDirectory $($Arguments -join " ")"
  }

  return ($output | Out-String).Trim()
}

function Get-GitOutputOrEmpty {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments
  )

  $output = & git "-c" "safe.directory=$gitSafeDirectory" @Arguments 2>$null
  if ($LASTEXITCODE -ne 0) {
    return ""
  }

  return ($output | Out-String).Trim()
}

function Test-HasStagedChanges {
  & git "-c" "safe.directory=$gitSafeDirectory" diff --cached --quiet
  return $LASTEXITCODE -eq 1
}

function Assert-ProjectFiles {
  if (-not (Test-Path (Join-Path $rootDir "package.json"))) {
    throw "package.json nao encontrado na raiz do projeto."
  }
}

function Ensure-GitRepository {
  if (-not (Test-Path (Join-Path $rootDir ".git"))) {
    Write-Host ""
    Write-Host "> git init"
    & git init
    if ($LASTEXITCODE -ne 0) {
      throw "Falha ao executar: git init"
    }
  }

  Invoke-Git -Arguments @("branch", "-M", "main")

  $remoteOutput = Get-GitOutputOrEmpty -Arguments @("remote")
  $remotes = @($remoteOutput -split "`r?`n" | Where-Object { $_ })

  if ($remotes -contains "origin") {
    Invoke-Git -Arguments @("remote", "set-url", "origin", $repoUrl)
  } else {
    Invoke-Git -Arguments @("remote", "add", "origin", $repoUrl)
  }

  $configuredName = Get-GitOutputOrEmpty -Arguments @("config", "--get", "user.name")
  $configuredEmail = Get-GitOutputOrEmpty -Arguments @("config", "--get", "user.email")

  if (-not $configuredName) {
    Invoke-Git -Arguments @("config", "user.name", $gitUserName)
  }

  if (-not $configuredEmail) {
    Invoke-Git -Arguments @("config", "user.email", $gitUserEmail)
  }
}

function Remove-ExcludedPathsFromIndex {
  foreach ($target in $excludedPaths) {
    $args = @("rm")

    if ($target -in @("site", "tmp")) {
      $args += "-r"
    }

    $args += @("--cached", "--ignore-unmatch", $target)
    & git "-c" "safe.directory=$gitSafeDirectory" @args 2>$null | Out-Null

    if ($LASTEXITCODE -ne 0) {
      throw "Falha ao remover $target do indice git."
    }
  }
}

function Publish-Bot {
  Assert-ProjectFiles
  Ensure-GitRepository
  Remove-ExcludedPathsFromIndex
  Invoke-Git -Arguments @("add", ".")

  if (Test-HasStagedChanges) {
    $commitMessage = if ($env:BOT_COMMIT_MESSAGE) {
      $env:BOT_COMMIT_MESSAGE
    } else {
      "bot: update $(Get-Date -Format o)"
    }

    Invoke-Git -Arguments @("commit", "-m", $commitMessage)
  } else {
    Write-Host ""
    Write-Host "Nenhuma mudanca nova para commit na raiz do bot."
  }

  Invoke-Git -Arguments @("push", "-u", "origin", "main")
  Write-Host ""
  Write-Host "Bot publicado com sucesso."
}

try {
  Publish-Bot
} catch {
  Write-Host ""
  Write-Host "Erro ao publicar o bot: $($_.Exception.Message)"
  exit 1
}
