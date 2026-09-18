#!/usr/bin/env python3
"""Retired local Deep Research plan renderer.

The local-runtime deep-research skill is final-only: the current agent reads
SKILL.md and steps/*.md directly, keeps steps 1-4 in session context, and writes
only the final_turn_XXX.md artifact in step 5. Rendering a Team Engine plan here
would reintroduce the old multi-file pipeline, so fail fast if this stale entry
point is invoked.
"""

from __future__ import annotations

import sys
from textwrap import dedent


MESSAGE = """
local-runtime deep-research no longer renders a Team Engine plan.

Use the deep-research skill directly: read SKILL.md, then read and execute
steps/1_background.md through steps/5_writing.md in order in the current agent
session. Steps 1-4 stay in session context; step 5 writes the final_turn_XXX.md
artifact.
"""


def main() -> int:
    sys.stderr.write(dedent(MESSAGE).strip() + "\n")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
