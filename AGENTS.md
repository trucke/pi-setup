# Repository guidelines

## Scope

This repository packages the selected Pi extensions, skills, themes, and their runtime dependencies. Keep changes focused on package behavior and repository maintenance. Global or personal agent instructions belong outside this public repository.

## Implementation

- Prefer simple, idiomatic, and type-safe solutions.
- Avoid `any` in TypeScript. Prefer inference and types derived from the source APIs.
- Comments should explain non-obvious intent, constraints, or trade-offs and remain accurate after changes.
- Keep package resources explicit in the `pi` manifest in `package.json`.
- Do not modify installed package checkouts under `~/.pi/agent`; change this source repository and deploy a reviewed release.

## Package manager

Use pnpm exclusively. Keep `pnpm-lock.yaml` committed and do not introduce npm or another package manager's lockfile.

## Validation

Run the focused tests for the changed area and, before release:

```sh
pnpm test
pnpm check
pnpm format:check
pnpm pack --dry-run
```

## Version control

This is a colocated Jujutsu/Git repository. Keep each logical change reviewable and use `jj` for working-copy history. Do not rewrite or publish unrelated work.

## Releases

Release from an empty working-copy change directly on synchronized `main`:

```sh
./scripts/release vX.Y.Z
```

The command validates both repositories, bumps `package.json`, creates the dedicated `chore: release vX.Y.Z` change, and pushes `main` with a matching lightweight tag. It then updates the pinned package in `~/.dotfiles`, inserts that change directly after dotfiles `main`, rebases existing live dotfiles work on top, validates it, and pushes only the pin change. It never replaces the live dotfiles checkout or publishes unrelated work.

If `pi-setup` is published but the dotfiles update fails, keep the published tag immutable and follow the recovery instructions printed by the command.
