# Release Checklist

This repository is an unofficial fork. A source tag and a binary VSIX have
different release requirements; do not publish a VSIX under the MathWorks
publisher identity.

## One-time fork setup

- [x] Rename the current `origin` remote to `upstream`.
- [x] Add the maintainer-owned GitHub fork as `origin`.
- [x] Fork the language-server submodule, push its reviewed security commit,
      and update `.gitmodules` plus the parent submodule pointer.
- [x] Add maintainer-owned repository and issue URLs. The fork name, display
      name, author, version, and icon are distinct from the official extension.
- [ ] Replace the temporary `unpublished` publisher before Marketplace release.
- [x] Enable GitHub private vulnerability reporting.
- [x] Disable or replace inherited workflows that require MathWorks secrets.
- [x] Document that the official extension must be disabled to avoid duplicate
      MATLAB commands and services.

## Every release

1. Start from a clean checkout with recursive submodules.
2. Use the Node.js version pinned by CI.
3. Install only from lockfiles:

   ```sh
   npm run project-install-clean
   ```

4. Run the release gate:

   ```sh
   npm audit
   npm audit --prefix server
   npm audit --prefix server/src/licensing/gui
   npm run compile
   npm run lint
   npm run test-wsb:fast
   npm test --prefix server
   npm run package:check
   ```

   The package check compiles the release payload and prunes server development
   dependencies. Run `npm run project-install-clean` before further development.

5. Run `examples/variable_editor_demo.m` against every supported MATLAB release
   selected for the release and verify matrix scrolling, table headers,
   structures, automatic refresh, restored panels, and dimension slices.
6. Confirm the package publisher is not the `unpublished` release guard, then
   update `CHANGELOG.md`, version fields, and security review date.
7. Build once from the clean checkout with `npm run package`.
8. Inspect the VSIX file list, scan for credentials, and record its SHA-256.
9. Install that exact artifact into a clean VS Code profile and repeat the
   manual smoke test.
10. Tag the source commit. Attach the VSIX, checksum, changelog excerpt, upstream
    base commit, and supported MATLAB/VS Code versions to the GitHub release.

Generated VSIX files are release assets and are not committed to the source tree.
