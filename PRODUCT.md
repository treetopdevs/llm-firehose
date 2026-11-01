# Product

## Register

product

## Users

One developer running several AI coding agents (Claude Code, Codex, OpenCode, Antigravity) at the same time, across many git worktrees on one Mac. They glance at the desktop app between turns to answer: which agent needs me, what is each one doing, where (which checkout, which branch), and what did a finished session actually do. They know git, terminals and agents well. They do not remember session UUIDs and never will.

## Product Purpose

Agent Firehose is a local-first timeline of agent activity: an on-device capture engine plus a Bubble Tea TUI and a Tauri desktop shell. Nothing leaves the machine. Success is the user trusting the board enough to run more agents in parallel than they could track by hand, and being able to land on any session, worktree or commit from any other screen without reading a hash.

## Brand Personality

Calm, dense, exact. The tone of a good flight-operations board or a well-kept lab notebook: every row carries evidence, nothing is decorated, nothing shouts unless an agent is blocked. Power over privacy on the user's own machine: local views favor readable names over digests.

## Anti-references

- SaaS analytics dashboards: hero metrics, KPI tiles, gradient accents, identical card grids.
- Observability "dark blue with neon" skins, glassmorphism, gradient text.
- Chat-app friendliness: avatars, rounded bubbles, emoji status.
- Any surface that identifies a thing by its hash when a human name exists.

## Design Principles

1. **Name it like the user would.** A session is "what was asked, where, by which agent, when", never a UUID. Hashes are copyable details, not labels.
2. **Every screen links to the others.** Map, timeline, sessions and lanes are altitudes over the same event stream; moving between them keeps scope and selection.
3. **Evidence, not inference.** State words come from captured events; missing telemetry is shown as unknown, never as done.
4. **Attention earns color.** Accent and warm tones mark what needs the user; everything else sits in tinted neutrals.
5. **Dense but legible.** Monospace for identifiers and clocks, system sans for prose; one type scale, predictable grids, no nested containers.

## Accessibility & Inclusion

Keyboard operable throughout (tab order, Enter/Space on rows, ⌘K search). Color never carries state alone: state has a word next to the dot. Respect prefers-reduced-motion; motion only conveys state changes. Contrast at WCAG AA on the dark surface.

See [DESIGN.md](DESIGN.md) for the visual system and design tokens.
