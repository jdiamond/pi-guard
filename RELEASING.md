# Releasing

1. Ensure `git status --short` is clean (no uncommitted changes)
2. Ensure `npm run verify` passes (typecheck + lint + format:check + test)
3. Update `CHANGELOG.md` — replace `[Unreleased]` with `[X.Y.Z] - YYYY-MM-DD`
4. Commit: `git commit -m "Update changelog for X.Y.Z"`
5. Bump version: `npm version <patch|minor|major>`
   - This bumps `package.json`, commits, and tags automatically
6. Push: `git push && git push --tags`
7. GitHub Actions publishes to npm on the tag
8. Wait for confirmation emails from GitHub (workflow succeeded) and npm (package published)
9. Test the published package:
   - Remove local path from `~/.pi/agent/settings.json` `packages` array
   - Install: `npm_config_min_release_age=0 pi install npm:pi-guard`
   - Verify with `/guard list` in pi