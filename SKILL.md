---
name: personal-knowledge
description: always use this skill when the user asks about history, projects and you don't have much context or are a new session. You can work out what they have been working on, todos, notes, preferences and more
---

## Step 1: Read these first

```bash
cat ~/perception/wiki/owner.md     # Who the user is, role, interests, recent activity
cat ~/perception/wiki/todos.md     # Open commitments — things they said they'd do
```

These two files tell you who you're talking to and what's on their plate.

## Step 2: Check projects if relevant

```bash
ls ~/perception/wiki/projects/
cat ~/perception/wiki/projects/<name>.md
```

Each project page has purpose, status, key people, and often a backlog.

## Step 3: Check people if relevant

```bash
ls ~/perception/wiki/persons/
cat ~/perception/wiki/persons/<name>.md
```

Person pages describe collaborators — role, relationship to the user, recent interactions.

## Step 4: Check today's activity if needed

```bash
# Daily notes use dates/YYYY/MM/DD.md
cat ~/perception/wiki/dates/2026/04/19.md
```

Daily notes are verbose timestamped logs. Only read if you need specifics about what happened on a particular day.

## Setup

For CLI use, pass `--add-dir ~/perception/wiki` so the wiki is accessible:

```bash
claude --add-dir ~/perception/wiki
```

## Rules

- Read `owner.md` and `todos.md` before answering questions about the user or their work.
- Don't read everything — go to projects or persons only when the conversation needs it.
- Todos are real commitments to real people. Treat them seriously.
- The wiki updates in the background. Content may be minutes old, not seconds.
