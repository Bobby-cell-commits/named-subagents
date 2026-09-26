"""Plugin entry point: runs the named_subagents CLI from the plugin checkout, so the
plugin needs no pip install. Hook commands call it as
`python3 "${CLAUDE_PLUGIN_ROOT}/hooks/run.py" <cli args>`."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from named_subagents.cli import main  # noqa: E402

sys.exit(main())
