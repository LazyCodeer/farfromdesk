# Claude CLI with an API key or Ollama

FarFromDesk starts the native Claude executable directly. A PowerShell function such as
`function claude { ollama launch claude --model gemma4 $args }` exists only in that
PowerShell session. Ollama sets provider variables for its child Claude process;
it does not set them for an already running FarFromDesk process. FarFromDesk does
not execute shell profiles to discover or reproduce functions.

`ANTHROPIC_MODEL` selects a model; it does not select an endpoint. For local Ollama,
the endpoint and authentication placeholder must be configured as well.

## Windows setup

For a desktop app started from Explorer, merge this into your existing
`%USERPROFILE%\.claude\settings.json` (or the settings directory selected by
`CLAUDE_CONFIG_DIR`). Keep other settings. These values select local Ollama for
Claude CLI generally, not just for FarFromDesk:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:11434",
    "ANTHROPIC_AUTH_TOKEN": "ollama",
    "ANTHROPIC_API_KEY": "",
    "ANTHROPIC_MODEL": "gemma4",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "gemma4",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "gemma4",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gemma4",
    "CLAUDE_CODE_SUBAGENT_MODEL": "gemma4"
  }
}
```

Use the exact installed model/tag from `ollama list`. Keep Ollama running. The
`ollama` token above is a placeholder for the local server, not an Ollama cloud
credential. Cloud endpoints require their real credentials.

Check the executable directly, bypassing your PowerShell function:

```powershell
claude.exe auth status
```

Then use **Check apps** in a FarFromDesk build containing this fix. API/token
configurations show **API / token configured**; the native coordinator setup still
needs to succeed before the coordinator is ready. Existing routes whose provider
fingerprint changed must be reviewed/reselected before reuse.

For session-only configuration, PowerShell uses `$env:`, not Bash's `export`:

```powershell
$env:ANTHROPIC_BASE_URL = 'http://localhost:11434'
$env:ANTHROPIC_AUTH_TOKEN = 'ollama'
$env:ANTHROPIC_API_KEY = ''
$env:ANTHROPIC_MODEL = 'gemma4'
$env:ANTHROPIC_DEFAULT_OPUS_MODEL = 'gemma4'
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = 'gemma4'
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = 'gemma4'
$env:CLAUDE_CODE_SUBAGENT_MODEL = 'gemma4'
claude.exe auth status
```

Those values reach programs launched from that PowerShell session. They do not
update Explorer or an existing background bridge. Fully exit the existing bridge
before launching FarFromDesk from that same terminal if using this approach.
Claude's settings can override shell variables, so check existing settings too.
Persistent user settings are simpler for normal desktop launches.

## What detection verifies

The old account check required an email/account ID or a credential in the bridge's
own environment. Claude reports Ollama's `ANTHROPIC_AUTH_TOKEN=ollama` as
`loggedIn: true`, `authMethod: oauth_token`, without email. A native user-settings
API key/token or credential helper could therefore be wrongly rejected. Separately,
the UI displayed “Sign in first” for every failed account check.

The new check runs `claude auth status` (JSON by default), accepts native
`api_key`, `api_key_helper`, `oauth_token` and `third_party` configurations as
**configured**, and preserves **unknown** when the check fails. It does not call a
model just to discover configuration. The SDK inherits the bridge environment and
continues using Claude's native user/project/local settings and permission rules.

Routes pin opaque hashes of provider/model environment values, relevant settings
in the user/current-project/local files, file-based managed settings/drop-ins and
the stored Console API key. Source changes stop reuse until reselected. No raw
keys/endpoints or helper output are included in the UI or stored route. Credential
helpers are never run separately by the fingerprint reader. Hashes describe
configuration, not the principal returned by a rotating helper or an OS/cloud
credential chain. OS-managed registry/MDM policy and remote account changes are
still enforced by the native CLI; this check does not independently attest them.

Chat success is not proof that a model supports coordinator tools, sufficient
context, or every Claude feature. Ollama recommends tool-capable models and a 64K+
context for coding. FarFromDesk does not invent a context size for `gemma4` or
disable native permission checks.

## Evidence and sources (29 October 2026)

- [Ollama's Claude Code integration](https://docs.ollama.com/integrations/claude-code):
  manual local endpoint/token configuration and supported launch behavior.
- [Ollama's launcher implementation](https://github.com/ollama/ollama/blob/main/cmd/launch/claude.go):
  child-process environment injection, `--model`, and model-tier variables.
- [Claude CLI reference](https://code.claude.com/docs/en/cli-reference): native
  auth-status JSON and auth methods.
- [Claude settings](https://code.claude.com/docs/en/settings) and
  [environment precedence](https://code.claude.com/docs/en/settings-reference#env):
  Windows user path, persistent settings and overrides.

Verified offline regression tests cover native statuses, errors, configuration
fingerprints, session pinning, SDK environment/settings/permission preservation,
and desktop status text. A real installed macOS Claude CLI was also checked with
isolated temporary home/settings and the local dummy Ollama configuration: native
status returned `oauth_token`, and the patched FarFromDesk probe returned
`configured`. No inference request was sent. Windows executable resolution is
covered by portable tests; a real Windows FarFromDesk + Ollama coordinator run and
the pictured Windows executable remain unverified/unmodified.
