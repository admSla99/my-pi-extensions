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

Generate a commit subject with `openai/gpt-5.6-luna`, then commit and push:

```text
/ship
```

Supply the subject directly to skip the model call:

```text
/ship fix: preserve login redirect
```

`/ship` waits for the active agent to become idle and detects the remote's default branch:

- On the default branch, it moves staged changes or unpushed local commits to a new branch derived from the commit subject, then restores the local default branch to its remote ref.
- On any other branch, it commits there directly.
- It pushes the branch and reuses its open pull request, or creates one with `gh pr create --fill` when none exists.

A branch without an upstream is pushed to `origin`, or to the only configured remote, with upstream tracking enabled. A clean default branch with no local commits is left unchanged.

The generated-subject flow runs an isolated, ephemeral Pi process with tools, extensions, skills, prompt templates, and context files disabled. It sends recent commit subjects and up to 48,000 characters of the staged diff to OpenAI. Supplying the subject avoids sending the diff to a model. Pull-request handling requires an authenticated GitHub CLI (`gh`).
