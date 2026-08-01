---
name: model_selection_planning
description: Advise optimal Claude model during planning/auto mode to balance capability with token efficiency
metadata: 
  node_type: memory
  type: feedback
  originSessionId: cab33e3c-658a-4282-9f8f-c2fec3db6712
  modified: 2026-07-29T19:08:55.083Z
---

When planning or in auto mode, advise which Claude model to use that balances best results with token efficiency by being concise.

**Why:** Planning and auto mode should be efficient with tokens while still delivering the right answer. Over-verbosity in mode wastes budget; model selection guidance helps the user make informed choices about compute trade-offs.

**How to apply:** During planning sessions (EnterPlanMode/ExitPlanMode) and autonomous/auto-mode tasks, when discussing model choice or recommending a model, specify both:
1. Which Claude model is best-suited for the task (considering capability requirements)
2. How token usage can be kept low (terseness, structure, avoiding unnecessary explanation)

For instance: "Sonnet 5 is ideal here (it has strong vision capabilities), and we'll stay token-efficient by focusing on structural changes only — no lengthy narrative."
