# Security Review

Review date: 2026-07-22  
Review target: Variable Editor fork version 1.4.0 and its three locked dependency trees

## Executive result

The Variable Editor has no identified direct MATLAB command-injection path in its current expression grammar, and no credentials or variable-value logging were found in the added source or packaged VSIX. The new Webview boundary, data transfer, refresh scheduling, clipboard output, and audited runtime dependency findings now have concrete controls.

The source is suitable for public review and the first clean Node 22 CI run passed. A Marketplace release remains blocked until the placeholder `unpublished` publisher is replaced and the final VSIX is rebuilt and inspected from its tagged checkout.

This is a source and dependency review, not a formal penetration test or a guarantee that the extension is vulnerability-free.

## Added Variable Editor findings

| Priority | Finding | Impact | Required action |
| --- | --- | --- | --- |
| Resolved | The scripted Webview now has a random nonce CSP with `default-src 'none'`; only nonce scripts/styles and explicit style attributes are allowed. `localResourceRoots` is empty. | Retain escaping and `textContent` when adding UI. |
| Mitigated | Pages are cell-bounded; JSON transfer is truncated in MATLAB at 4,000,001 characters and rejected above 4 MB; Webview structures are limited to depth 8 and 50,000 nodes. | `jsonencode` still constructs its source string inside trusted local MATLAB before truncation. A future lazy MATLAB serializer would reduce peak MATLAB memory for a single huge compound cell. |
| Resolved | Every Webview message is runtime-validated for type, finite positive integers, page count, source, selection bounds, and identifier-only nested expressions. | Keep the validator synchronized with protocol changes. |
| Resolved | Each panel uses a single-flight load queue. New page/refresh requests invalidate the current result and replace the one pending request. | MATLAB evaluation itself is not cancellable; the queue bounds overlap rather than interrupting it. |
| Mitigated | Hidden panels are marked dirty and refresh when visible instead of refreshing on every workspace event. | The upstream event does not identify which variable changed, so all visible editors still refresh. |
| Resolved | Top-level classes are allowlisted. Unsupported custom classes, function handles, `gpuArray`, and unknown values are rejected. | Supported containers should still be treated as trusted if they contain custom objects. |
| Resolved | Restored format, precision, and column width are allowlisted/clamped before rendering. | None. |
| Resolved | Clipboard copying is limited to 10,000 cells and 4 MB of UTF-8 output. | Clipboard contents remain outside the extension's control after the user copies them. |

### Command-injection analysis

The root variable and nested field expression must match a strict ASCII identifier/dot-path regular expression. Row, column, and page values are converted to numbers and clamped before interpolation. Table conversion wraps only the generated slice. Under these constraints, characters needed to terminate the expression or add another MATLAB statement cannot enter the generated command.

The current defense should still be centralized and tested at runtime. Do not broaden nested paths to arbitrary indexing text without replacing string construction with a structured MATLAB helper API.

### Webview/XSS analysis

MATLAB values inserted into generated HTML are normally passed through `escapeHtml`, while notifications use `textContent`. Variable expressions inserted in HTML and JavaScript are constrained by the identifier grammar. No working value-to-script injection path was identified.

That conclusion depends on every future insertion remembering to escape. A strict nonce CSP is therefore required as a second layer rather than relying on manual escaping alone.

## Inherited extension and dependency findings

The following findings exist in the upstream extension/server code or dependency graph; they were not introduced by the Variable Editor but are part of a forked VSIX release.

| Priority | Finding | Evidence and impact | Required action |
| --- | --- | --- | --- |
| Resolved | Server runtime overrides pin `websocket-driver@0.7.5` and `body-parser@1.20.6`; `npm audit --omit=dev --prefix server` reports zero findings. | Recheck the audit for every release. |
| Resolved | The licensing server binds to `127.0.0.1`, validates loopback or scoped Codespaces hosts/origins, and caps JSON requests at 100 KB. | Codespaces must be exercised in CI/manual release testing. |
| Resolved | The licensing bearer URL is stored under a non-symlink user-owned `~/.matlab-vscode` directory with `0700` directory and `0600` file permissions, owner validation, loopback URL validation, and cleanup. | Crash leftovers remain possible but cannot be accepted when owner/URL validation fails. Windows relies additionally on the user's home-directory ACLs. |
| Resolved | The top-level runtime override pins `brace-expansion@2.1.2`; `npm audit --omit=dev` reports zero findings. | Recheck the audit for every release. |
| Resolved | Reviewed exact overrides patch the audited build-time transitive dependencies, `@vscode/vsce` is updated to 3.9.2, and Mocha is updated to a current Node-compatible release. Full audits for the extension, server, and licensing-GUI lockfiles report zero findings as of the review date. | Keep Node 22 and exact lockfile installation in CI; re-audit every release. |

The licensing server uses a cryptographically random 32-character token, hashes it with SHA-256, and protects state-changing endpoints with token middleware. Session secrets are also random. Those are positive controls, but they do not replace loopback binding and secure token-file handling.

## Privacy and data handling

- Variable values travel locally from the existing MATLAB process to the VS Code extension host and then to the Variable Editor Webview.
- The added feature does not write variable values to disk and does not add network transmission.
- Copying a selection writes its TSV representation to the operating-system clipboard only after a user action.
- Inherited services can still call the telemetry interface, but the fork's implementation is a local no-op and contains no network endpoint or collection key. `MATLAB.telemetry` remains disabled and present only for settings compatibility.
- No API keys, access tokens, private keys, or embedded credentials were found in the reviewed added source or VSIX contents.

## License and public identity

The upstream repository is MIT licensed. Preserve its license and existing copyright notices, and clearly describe the fork's changes. New fork-owned files use the fork-contributor notice, while modified upstream files retain the original notice and add a modification notice where ownership would otherwise be ambiguous.

Before publishing:

- replace the temporary `unpublished` publisher before a Marketplace release;
- do not use `MathWorks.language-matlab` as the public extension identity;
- explain whether the official extension must be disabled to avoid duplicate commands, views, and automatic replacement;
- rename the Git remote containing the MathWorks URL to `upstream` and add the maintainer's fork as `origin`;
- publish generated VSIX files as release assets, not as a series of tracked source files.

## Build and repository integrity

`vscode:prepublish` now compiles the client and language server before pruning server development dependencies. `package:check` verifies required runtime files and rejects source, tests, environment files, and nested VSIX artifacts.

The reviewed checkout uses language-server fork commit `1cf94cd`, which contains the CLI parser, licensing server, dependency, and test changes and is published in the maintainer-owned server fork.

The demo is now tracked under `examples/` in the modified source checkout. Exclude `node_modules`, build output, local settings, and generated VSIX files from source control.

## Release gate

A public release should require all of the following:

- [x] Nonce CSP and empty Webview resource roots.
- [x] Runtime message validation with finite integer bounds.
- [x] Bounded transfer/depth/node count and bounded clipboard output.
- [x] Single-flight/coalesced data requests and visibility-aware refresh.
- [x] Explicit handling of custom MATLAB classes.
- [x] Patched production dependency audits for both client and server.
- [x] Loopback-only licensing server and protected token file.
- [x] Inherited outbound telemetry disabled.
- [x] Clean submodules and reproducible Node 22 `npm ci` build/package test.
- [ ] Fork-owned Marketplace publisher; repository URL, `name`, display name, icon, version, author, and new-file copyright are fork-owned.
- [x] No secrets detected in the source tree; repeat against the final packaged VSIX.
- [ ] Unit, workspace-browser, server, MATLAB integration, restore, and large-data tests pass. The 178 Workspace/Variable Editor tests and 240 language-server tests pass locally; MATLAB integration and clean-profile smoke tests remain.
