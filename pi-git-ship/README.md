# pi-git-ship

Pi extension that registers `/ship` for staging, committing, pushing, and opening a pull request without using the main session's model.

## Install

From the repository root:

```bash
pi install /absolute/path/to/my-pi-extensions/pi-git-ship
```

Or load it for one session:

```bash
pi -e ./pi-git-ship/index.ts
```

## Usage

Generate commit and pull-request metadata with one `openai/gpt-5.6-luna` call, then commit and push:

```text
/ship
```

Supply the commit subject directly. On a feature branch with an existing PR this skips the model call; a new PR still needs one call for its title and description:

```text
/ship fix: preserve login redirect
```

`/ship` waits for the active agent to become idle and detects the remote's default branch:

- On the default branch, it moves staged changes or unpushed local commits to a new branch derived from the commit subject, then restores the local default branch to its remote ref.
- On any other branch, it commits there directly.
- It pushes the branch and reuses its open pull request, or creates one with `gh pr create --fill` when none exists.

A branch without an upstream is pushed to `origin`, or to the only configured remote, with upstream tracking enabled. A clean default branch with no local commits is left unchanged.

The metadata flow runs an isolated, ephemeral Pi process with tools, extensions, skills, prompt templates, and context files disabled. One call produces the commit subject, a short branch name, a focused PR title, and a non-empty Markdown description from both committed and staged changes. It follows a repository PR template when present and sends at most 48,000 characters of diff to OpenAI. Pull-request handling requires an authenticated GitHub CLI (`gh`).
