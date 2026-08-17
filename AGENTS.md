# Repository guidelines

## Scope

This repository packages the selected Pi extensions, skills, themes, and their runtime dependencies. Keep changes focused on package behavior and repository maintenance. Global or personal agent instructions belong outside this public repository.

## Implementation

- Prefer simple, idiomatic, and type-safe solutions.
- Avoid `any` in TypeScript. Prefer inference and types derived from the source APIs.
- Comments should explain non-obvious intent, constraints, or trade-offs and remain accurate after changes.
- Keep package resources explicit in the `pi` manifest in `package.json`.
- Do not modify installed package checkouts under `~/.pi/agent`; change this source repository and deploy a reviewed release.

## Validation

Run the focused tests for the changed area and, before release:

```sh
npm test
npm run check
npm run format:check
npm pack --dry-run
```

## Version control

This is a colocated Jujutsu/Git repository. Keep each logical change reviewable and use `jj` for working-copy history. Do not rewrite or publish unrelated work.

## Releases

- Update the version in both `package.json` and `package-lock.json` in a dedicated `chore: release vX.Y.Z` commit.
- Move `main` to the reviewed release commit and push it.
- Publish a matching lightweight `vX.Y.Z` tag.
- Installed Git packages are pinned. Deploy a release explicitly with `pi install git:github.com/trucke/pi-setup@vX.Y.Z`.
