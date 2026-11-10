# Privacy

Claude Status Bar collects no data and has no servers. It runs entirely on your Mac. Its only network activity is a once-a-day update check: one request to GitHub's public API for the latest release tag, and one to Homebrew's public formulae API for the current cask version, used only to show the update line in the menu. Nothing is sent to the developer (as with any update check or download, GitHub and Homebrew see the request; the developer never does).

When a chat finishes, the app can pause playing media by sending local scripting commands to your browsers and media apps. It does not read page content, and nothing leaves your Mac.

Session model, effort, and account usage values are received locally from Claude Code and stored only under `~/.claude/statusbar`. They are never sent anywhere by Claude Status Bar.

---
Back to the [README](README.md).
