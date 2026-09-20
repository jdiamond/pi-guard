# Releasing

Releases are prepared in a pull request because `main` is protected by a
repository ruleset. The release PR contains the changelog and package version
bump; publishing happens only after the versioned commit has been merged and
tagged.

1. Start from an up-to-date `main` branch:
   ```bash
   git switch main
   git pull --ff-only
   git switch -c release/vX.Y.Z
   ```
2. Update `CHANGELOG.md`:
   - Change the current `[Unreleased]` heading to `[X.Y.Z] - YYYY-MM-DD`.
   - Add a new empty `## [Unreleased]` section at the top for future changes.
3. Bump the package version without creating a commit or tag:
   ```bash
   npm version X.Y.Z --no-git-tag-version
   ```
   This updates `package.json` and `package-lock.json` in the release branch.
4. Run the full verification suite:
   ```bash
   npm run verify
   ```
5. Commit the release preparation and push the branch:
   ```bash
   git add CHANGELOG.md package.json package-lock.json
   git commit -m "Prepare release X.Y.Z"
   git push -u origin release/vX.Y.Z
   ```
6. Open a pull request against `main`. Wait for the required `verify` check to
   pass, then merge the pull request. Do not push the release commit directly
   to `main`.
7. Tag the merged commit from an up-to-date local `main`:
   ```bash
   git switch main
   git pull --ff-only
   git tag -a vX.Y.Z -m "Release vX.Y.Z"
   git push origin vX.Y.Z
   ```
8. The `publish.yml` GitHub Actions workflow runs for the `vX.Y.Z` tag. It
   installs dependencies, runs `npm run verify` again, and publishes to npm
   with trusted publishing/provenance. Publishing stops if verification fails.
9. Confirm the workflow succeeded and the package is available:
   ```bash
   gh run list --workflow publish.yml --limit 1
   npm view pi-guard version
   ```
10. Test the published package:
    - Remove the local path from the `packages` array in
      `~/.pi/agent/settings.json`.
    - Install it:
      ```bash
      npm_config_min_release_age=0 pi install npm:pi-guard
      ```
    - Verify it in pi with `/guard list`.
    - Clean up and restore the local checkout:
      ```bash
      pi uninstall npm:pi-guard
      ```
      Then add the local path back to `settings.json`.

Issues remain open after their implementation PR is merged. Close them after
the corresponding release is published.
