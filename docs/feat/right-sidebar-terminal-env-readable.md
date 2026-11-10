---
description: "Proposed environment inheritance for right-sidebar user terminals, without relaxing credential filtering for agent tools or other child processes."
---

# Right-sidebar terminal environment inheritance

English | [中文](right-sidebar-terminal-env-readable.zh.md)

## Summary

This proposal lets a user opt into credential-bearing environment inheritance for the right-sidebar Terminal. The existing filtered behavior remains the default. Agent shell tools, agent-owned persistent terminals, MCP servers, LSP servers, and subagents retain their existing environment policies.

Status: implemented in this checkout; the unsigned Windows x64 installer and its packaged environment policy have been verified. The installed desktop runtime has not been replaced, and the reported startup-file failure has not been reproduced. This document records the implementation design; the owning [controller reference](../../packages/api/terminal-controller/README.md) documents configuration.

## Table of Contents

- [Scope and current evidence](#scope-and-current-evidence)
- [Proposed behavior](#proposed-behavior)
- [Implementation responsibilities](#implementation-responsibilities)
- [Startup files and Windows environment](#startup-files-and-windows-environment)
- [Security and alternatives](#security-and-alternatives)
- [Acceptance and verification](#acceptance-and-verification)
- [Delivery sequence](#delivery-sequence)

<a id="scope-and-current-evidence"></a>
## Scope and current evidence

The product behavior change is limited to human-operated terminals opened from the right sidebar. Shared subprocess and SSH changes are permitted only to carry and implement that terminal-specific choice; they must not relax another consumer's defaults or expose a new model-facing environment override.

| Subject | Inspected basis | Implication |
|---|---|---|
| Credential filtering | [Shared environment helper](../../packages/subprocess/subprocess/src/index.ts#L40-L79) | DSH, not Cordis itself, removes names matching `KEY`, `PASSWORD`, `SECRET`, or `TOKEN`, and names starting with `DSH_`, case-insensitively. |
| Sidebar allocation | [Terminal controller](../../packages/api/terminal-controller/src/index.ts#L313-L325) | The controller passes explicit Session identity but no environment-inheritance choice. |
| Explicit overrides | [Local environment composition](../../packages/subprocess/subprocess-local/src/spawn.ts#L36-L54) | Explicit entries can restore filtered variables; Windows names are merged case-insensitively. |
| User permissions | [User-terminal permissions decision](../../.agents/notes/implemented/architecture/2026-09-16-user-terminal-permissions.md) | Sidebar terminals already run independently of agent sandbox permissions; credential filtering remains separate. |
| Shell startup | [Sidebar shell profiles](../../packages/api/terminal-controller/src/shells.ts#L24-L27) and [Bash activity integration](../../packages/subprocess/subprocess-local/src/shell-activity.ts#L63-L96) | Sidebar defaults do not disable startup files; supported POSIX Bash integration explicitly sources the user's `.bashrc`. |
| Agent terminal defaults | [Agent terminal configuration](../../packages/terminal/terminal-bash/src/config.ts#L62-L67) | Agent-owned terminals use profile-free arguments and are not the target of this proposal. |

Source inspection establishes the filtering mechanism, not the cause of every missing variable or startup-file failure. Installed-version differences, selected shell, launch arguments, home-directory selection, and the parent process environment remain runtime verification items.

<a id="proposed-behavior"></a>
## Proposed behavior

The sidebar terminal controller exposes a server-side `environmentMode` field. Cordis holds this setting as a volatile reference so a mode-only configuration update does not replace the controller or close its existing terminals.

| Value | Proposed behavior |
|---|---|
| `scrubbed` | Default. Preserve the existing credential-name filtering and internal-variable separation. |
| `inherit-user` | Inherit the execution provider's parent environment without credential-name filtering. Continue separating internal `DSH_*` variables, then apply deliberate terminal overrides. |

The inherited environment is a snapshot taken when each terminal is allocated. Changing the setting affects new terminals only; existing shells and their descendants keep their environment. The user must close and reopen a terminal to change its inheritance policy.

The controller, not browser input or the selected shell, chooses the mode from validated deployment configuration. Invalid values fail configuration validation. Do not add a per-create Remote parameter, an agent tool parameter, or a new sidebar control in this change.

`inherit-user` deliberately makes all matching parent credentials available, including DSH's provider credentials if present. It does not mean only credentials associated with the current project. Preserve the existing explicit `DSH_SESSION_ID` override and existing provider-private control-variable handling; do not restore ambient `DSH_*` entries wholesale.

<a id="implementation-responsibilities"></a>
## Implementation responsibilities

Environment selection belongs to the provider that starts the process. A controller-side spread of `process.env` would copy the Web Host's environment, which is incorrect when the Session executes over SSH.

1. Extend the terminal spawn specification with an explicit optional environment mode. Omission resolves to `scrubbed` in the provider's environment-resolution step, preserving every existing caller. Do not add the mode to ordinary process spawn requests.
2. Add the validated controller setting, default it to `scrubbed`, and pass it only from right-sidebar terminal allocation. Keep all other consumers unchanged.
3. Implement environment resolution in the local subprocess provider: choose the ambient base, remove ambient internal names, apply existing proxy normalization, merge explicit entries using platform-specific name semantics, and retain existing final validation and private-control handling. Leave `scrubbedParentEnv()` and its other consumers' behavior unchanged; reuse the existing composition owner rather than creating a second sidebar-only merge algorithm.
4. Carry the mode through the SSH terminal request, its parser, and the helper's terminal allocation. Resolve inheritance on the remote execution host, not on the SSH client. Update every affected typed consumer and wire validator together.
5. Preserve PTY lifecycle, process ownership, dimensions, terminal emulation, activity integration, output retention, and agent sandbox behavior. No credential value belongs in a setting, process metadata, diagnostic, or new Session event.

A provider that cannot honor an explicit mode must reject allocation with an actionable unsupported-mode error, rather than silently substitute another environment policy. Define that failure before allocation so no unpublished process needs cleanup. Existing allocation and cleanup failures retain their current ownership.

<a id="startup-files-and-windows-environment"></a>
## Startup files and Windows environment

Environment inheritance and startup-file selection are separate features. This proposal does not remove startup restrictions from agent terminals, force login shells, or rewrite the user's startup files.

For sidebar Bash, verify the actual executable, effective arguments, home directory, and startup-file execution before adding any startup workaround. Bash login profiles and interactive non-login startup files are not interchangeable. On Windows, selecting cmd or PowerShell does not imply Bash startup-file execution; a configured Git Bash or WSL launcher must be investigated in its own execution environment.

For Windows, `inherit-user` uses the environment already held by the DSH execution process. It does not read the user or machine registry, refresh Explorer's environment, or retrieve changes made after DSH started. After changing Windows environment settings, restart the complete DSH desktop/Host process and open a new terminal for verification. A fresh terminal alone cannot update a stale Host environment.

Test startup-file execution with a harmless sentinel variable, and check credential availability by presence or a synthetic value. Do not dump the real environment or startup-file contents into the agent conversation. Real user startup configuration is outside this document's inspected evidence.

<a id="security-and-alternatives"></a>
## Security and alternatives

Opting in grants the shell, startup scripts, commands, and descendants access to inherited credentials. Sidebar output remains outside automatic agent history, but terminal programs, file writes, pasted output, browser screen recovery, or a user-authorized export can still disclose credentials. Output separation is not a credential-isolation guarantee. The feature adds neither operating-system privilege nor an exception to existing Remote access checks.

The mode changes implicit inheritance only. A filtered shell may still obtain credentials from readable files, startup scripts, credential managers, or explicit overrides; `scrubbed` is not a complete secret-isolation mechanism. Do not claim that retaining filtering makes an unrestricted user shell unable to read secrets.

| Alternative | Decision |
|---|---|
| Remove the shared credential filter | Reject: this would also change agent, MCP, LSP, and subagent exposure. |
| Add an environment-name allowlist | Defer: narrower exposure, but requires ongoing configuration for each needed variable; not required for the selected two-mode proposal. |
| Pass the Host's entire environment as controller overrides | Reject: wrong execution host under SSH and accidental restoration of internal variables. |
| Make unfiltered inheritance the sidebar default | Defer: changes exposure without explicit opt-in; this proposal preserves existing installations. |

<a id="acceptance-and-verification"></a>
## Acceptance and verification

Use synthetic values, unique temporary directories, and owned child-process cleanup. The following acceptance criteria apply to the implementation. Platform-specific cases require their owning hosts; successful source, browser, and packaged-runtime checks do not replace full installation acceptance.

| Scenario | Required result |
|---|---|
| Omitted mode and explicit `scrubbed` | Synthetic `KEY`, `PASSWORD`, `SECRET`, and `TOKEN` variables remain absent; ordinary parent variables survive. |
| Explicit `inherit-user` | All four synthetic credential-name classes reach the sidebar shell and a child command. |
| Internal variables and overrides | Ambient `DSH_*` variables remain absent in both modes; explicit Session identity and existing private process-control handling remain intact. |
| Windows name semantics | Mixed-case inherited names and explicit overrides resolve to a single effective variable without credential-filter case bypasses. |
| Bash startup | A temporary readable `.bashrc` exports a sentinel in the supported sidebar launch; this assertion is independent of the credential-mode assertion. |
| PowerShell startup | A controlled profile sentinel is loaded by the sidebar profile-capable launch; agent profile-free behavior is unchanged. |
| Other consumers | Agent ordinary shell, agent persistent terminal, MCP, LSP, and subagent behavior remain filtered unless their pre-existing explicit overrides supply a value. |
| Configuration and provider failures | Invalid configuration is rejected; unsupported explicit modes fail before allocation without leaking environment values. |
| Lifetime | Existing terminals retain their original environment after a setting change; new terminals use the new policy. |
| SSH | Inheritance uses the helper host's synthetic environment, never the controller host's; wire validation preserves the selected mode. |
| Real application composition | Boot the shipped profile with a test overlay and exercise sidebar allocation through Remote; prove both modes and unchanged agent filtering with a keyless recorded scenario. |

Focused tests must cover the controller, local provider environment composition and real PTY behavior, and SSH serialization/helper execution. The shipped-profile test must not replace the real composition with a hand-built plugin tree. Windows checks must include the installed desktop execution path before claiming the reported problem is resolved.

<a id="delivery-sequence"></a>
## Delivery sequence

First reproduce the user's installed sidebar shell and separate environment filtering from startup-file selection. Then implement the opt-in policy and focused tests, including the negative cases that preserve other consumers' defaults. Do not bundle an unproven startup-file fix into the environment change.

Update the owning controller and subprocess documentation and configuration catalog through their normal authoring or generation paths when the fields exist. Review affected public and wire types, and document any actual compatibility break at implementation time. This proposal does not change Session persistence or require a Session format migration.

Build the affected desktop/Web artifacts before testing the existing GUI; editing this checkout does not update the installed application automatically. Enable the opt-in only after the user accepts credential exposure. To roll back, restore `scrubbed` and close all terminals opened under `inherit-user`; revert the parent process configuration separately if it was changed.

## Dev Note

The implementation preserves filtered defaults and does not modify user profiles or replace an installed application. Installer creation is separate from installation acceptance. The original startup-file symptom requires verification with the user's selected shell and home directory; environment inheritance alone does not establish its resolution.
