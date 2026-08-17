# pi-git-ship

Pi extension that registers `/ship` for staging, committing, and pushing the current Git repository without using the main session's model.

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

`/ship` waits for the active agent to become idle, stages all changes with `git add -A`, commits, and pushes the current branch. A branch without an upstream is pushed to `origin`, or to the only configured remote, with upstream tracking enabled. With a clean working tree, `/ship` pushes existing commits.

The generated-subject flow runs an isolated, ephemeral Pi process with tools, extensions, skills, prompt templates, and context files disabled. It sends recent commit subjects and up to 48,000 characters of the staged diff to OpenAI. Supplying the subject avoids sending the diff to a model.
