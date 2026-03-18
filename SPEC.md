# Credentials Registry Specification

## Purpose

The `credentials` repository defines credentials, evaluates claim issues, and
stores issued credential receipts for public discovery.

Published site surface:

- `skillcraft.gg/credentials` (rendered by `skillcraft-gg.github.io`)

Source of truth:

- Credential definitions and issued receipts in this repository.

## Identifier Format

Credential identifiers use `owner/slug`, for example:

- `skillcraft-gg/hello-world`

## Repository Layout

Credential definitions use a folder layout:

```
credentials/
  <owner>/
    <slug>/
      credential.yaml
      credential.png
      background.png
```

Issued credentials are written in a collision-safe namespace:

```
issued/
  users/
    <github>/
      <owner>/
        <slug>/
          credential.yaml
```

## Credential Definition

```yaml
id: skillcraft-gg/hello-world
name: Hello World
description: First credential for claim workflow verification
requirements:
  min_commits: 1
```

`requirements.mode` controls whether skill/loadout constraints are evaluated in
`and` or `or` mode.

```yaml
requirements:
  min_commits: 3
  mode: and | or
  skill:
    - blairhudson/threat-model
    - skillcraft-gg/code-review
  loadout:
    - blairhudson/secure-dev

images:
  credential: credential.png
  background: background.png
```

- `mode: and` means all declared skill/loadout requirements must be met.
- `mode: or` means at least one declared requirement must be met.
- If no skill or loadout requirements are declared, validation is only `min_commits`.

`images.credential` and `images.background` are optional and resolved relative to
the credential definition folder.

## Claim Submission

`skillcraft claim <credential-id>` creates a GitHub issue in
`skillcraft-gg/credentials` labeled `skillcraft-claim`.

Claim payload uses YAML:

```yaml
claim_version: 1
claimant:
  github: blairhudson
credential:
  id: skillcraft-gg/hello-world
sources:
  - repo: https://github.com/blairhudson/project-a
    commits:
      - a1b2c3
claim_id: sha256:5f9d1e
```

## Claim Verification

GitHub Actions verifies:

- claim format and target credential definition
- repository access and commit existence
- proof object availability for claimed commits
- requirement checks using configured mode (`and`/`or`)

On success, issue labels are set to `skillcraft-verified` and `skillcraft-issued`
and an issued credential is written.
The claim workflow also refreshes `credentials/index.json` and
`issued/users/index.json` and commits those index updates when they change.

On failure, issue label is set to `skillcraft-rejected` with an issue comment.

## Credential Issuance

Issued credentials are generated at:

`issued/users/<github>/<owner>/<slug>/credential.yaml`

Example:

```yaml
definition: skillcraft-gg/hello-world
subject:
  github: blairhudson
issued_at: 2026-03-15T10:05:00Z
claim_id: sha256:5f9d1e
source_commits:
  - a1b2c3
```

## Registry Indexes

Discovery artifacts are generated in-repo:

- `credentials/index.json` (all credential definitions)
- `issued/users/index.json` (issued credentials grouped by GitHub user)
