# Contributing

Thank you for contributing to this unofficial fork. Changes intended for the
official MATLAB extension should be proposed to the
[MathWorks upstream repository](https://github.com/mathworks/MATLAB-extension-for-vscode).

## Before opening an issue

- Search existing issues and confirm the problem is specific to this fork.
- Include the operating system, VS Code version, MATLAB release, fork version,
  variable class/size, and minimal MATLAB code that reproduces the problem.
- Do not include proprietary workspace values, license tokens, credentials, or
  crash logs containing private paths unless they have been sanitized.
- Report security problems privately according to [SECURITY.md](SECURITY.md).

## Development setup

Clone recursively because the language server and syntax definitions are Git
submodules:

```sh
git clone --recurse-submodules https://github.com/Gureum-Yeoreum-Tori/matlab-variable-viewer-vscode.git
cd matlab-variable-viewer
npm run project-install-clean
npm run compile
npm run test-wsb:fast
```

Use Node.js 22, the version used in CI. Run these checks before submitting a
pull request:

```sh
npm run lint
npm run test-wsb:fast
npm test --prefix server
npm audit
npm audit --prefix server
npm audit --prefix server/src/licensing/gui
npm run package:check
```

`npm run package` and `npm run package:check` prune the language server's
development dependencies. Run `npm run project-install-clean` before doing more
server work afterward.

## Pull requests

- Keep a pull request focused and describe user-visible behavior.
- Add tests for data conversion, Webview interactions, and regressions.
- Update `CHANGELOG.md` under **Unreleased**.
- Preserve the upstream MIT license and copyright notices on upstream files.
  New fork-owned files should use the fork-contributor notice.
- Do not commit `node_modules`, `out`, generated VSIX files, local settings, or
  MATLAB workspace data.
- Do not add arbitrary MATLAB expression text to the Variable Editor protocol.
  Expression construction must remain behind validated identifiers and bounded
  numeric indices.

By contributing, you agree that your contribution is distributed under the
repository's MIT license.
