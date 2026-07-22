## Summary

Describe the user-visible change and why it is needed.

## Verification

- [ ] `npm run lint`
- [ ] `npm run test-wsb:fast`
- [ ] `npm test --prefix server` when server code changes
- [ ] All three `npm audit` commands in `RELEASING.md`
- [ ] `npm run package:check`
- [ ] Manual MATLAB test for affected classes, sizes, and dimensions

## Safety

- [ ] No MATLAB values, tokens, credentials, private paths, generated VSIX files,
      or local settings are committed.
- [ ] New Webview messages are runtime-validated and resource-bounded.
- [ ] `CHANGELOG.md` and relevant tests/documentation are updated.
