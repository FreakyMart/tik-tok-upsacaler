# Agent instructions

This repository is **Explainer Studio**, a code-first video editor. Videos are JSON files at
`projects/<name>/project.json`, rendered by the engine in `editor/engine/`.

Read [AI_GUIDE.md](AI_GUIDE.md) before creating or editing a video. Always run
`python studio.py validate <name>` after editing and look at `python studio.py sheet <name>`
before reporting that a video is done.
