"""Enable `python -m named_subagents ...` (delegates to the CLI).

This is the form the auto-namer hook registers (`python -m named_subagents hook
run`) — running the package as a module is more robust than depending on the
console script being on the PATH Claude Code runs hooks with.
"""
import sys

from named_subagents.cli import main

if __name__ == "__main__":
    sys.exit(main())
