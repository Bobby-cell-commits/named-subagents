"""
named_subagents — themed, non-repeating nicknames for Claude Code subagents.

A userspace port of Codex's per-instance `nickname_candidates`: every spawned
subagent instance gets a distinct, human-legible nickname drawn from a pool
themed to the *kind* of task it does (explorers for exploration, philosophers
for architecture reflection, detectives for debugging, ...). The names do not
repeat across iterations, backed by a persistent ledger.

Design contract
---------------
* stdlib-only, no third-party deps, Python 3.8+  -> runs on any Claude Code box.
* `registry.json` is the source of truth for pools + task->theme matching, so
  the data is language-agnostic (the JS port reads the same file).
* Deterministic given (category, generation, ledger-state): resume/re-run safe,
  mirroring the Workflow constraint that bans Math.random.
* Nicknames live ONLY in the prompt + label, never as a real subagent_type,
  dodging the "generic name silently overrides the system prompt" footgun.
* Security-forward: every name (bundled or from a user config) passes
  sanitization before it can reach a prompt or label (see NAME_PATTERN).

Two layers, mirroring Codex:
    role/subagent_type   <- Codex agent `name`           (native in Claude Code)
    nickname             <- Codex `nickname_candidates`  (this module)
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import stat
import tempfile
from typing import Dict, Iterable, List, NamedTuple, Optional, Sequence, Set, Tuple

try:
    import fcntl  # POSIX advisory file locks; absent on Windows
except ImportError:  # pragma: no cover - non-POSIX
    fcntl = None  # type: ignore[assignment]

__version__ = "0.4.0"

_HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_REGISTRY_PATH = os.path.join(_HERE, "registry.json")
GEN_SEP = "·"  # middle dot, e.g. "Magellan·2" on the 2nd cycle of the pool

CONFIG_ENV_VAR = "NAMED_SUBAGENTS_CONFIG"
# The implicit ./.named-subagents.json cwd config is the one untrusted-input
# surface (SECURITY.md). As of 0.3 it is OPT-IN: off unless enabled below.
NO_CWD_CONFIG_ENV_VAR = "NAMED_SUBAGENTS_NO_CWD_CONFIG"  # force off (also `--no-cwd-config`)
CWD_CONFIG_ENV_VAR = "NAMED_SUBAGENTS_CWD_CONFIG"  # opt back in (also `--cwd-config`)
LEDGER_VERSION = 2

# Registry / config files are semi-trusted local paths; a non-regular file
# (FIFO, /dev/zero) would hang open()+read(); an over-large one would OOM.
_MAX_FILE_BYTES = 32 * 1024 * 1024

# --- sanitization (D6) ------------------------------------------------------ #
# Nicknames flow into agent prompts and labels; with user configs they become
# untrusted input. NOTE: fullmatch is load-bearing — re.match(pat + "$") would
# accept "Name\n" (trailing-newline bypass).
NAME_PATTERN = r"[A-Za-z][A-Za-z0-9 .'-]{0,39}"
_NAME_RE = re.compile(NAME_PATTERN)
CATEGORY_KEY_PATTERN = r"[a-z][a-z0-9_-]{0,31}"
_CATEGORY_KEY_RE = re.compile(CATEGORY_KEY_PATTERN)
_BIO_BAD_RE = re.compile(r"[\x00-\x1f\x7f-\x9f`\[\]" + GEN_SEP + r"]")
_BIO_MAX_LEN = 120
# Unicode format/bidi/separator/zero-width code points that must never reach a
# prompt/label surface — line/para separators, bidi overrides & isolates,
# zero-width joiners/marks, BOM. (ASCII control is handled separately.)
_DANGEROUS_FORMAT = (
    r"\u2028\u2029\u202a-\u202e\u200b-\u200f\ufeff\u2066-\u2069")
# theme/blurb reach agent prompts (theme) and the categories listing (blurb);
# with a config (D6) they are untrusted, so strip ASCII control + the same
# prompt-breakers the bio rule blocks (backtick/bracket/GEN_SEP) + the dangerous
# Unicode format ranges. Normal punctuation and legit unicode letters survive.
_TEXT_BAD_RE = re.compile(
    r"[\x00-\x1f\x7f-\x9f`\[\]" + GEN_SEP + _DANGEROUS_FORMAT + r"]")
# emoji is a pictograph field: keep pictographs (and their VS-16 selectors), but
# strip ASCII control + the dangerous format/bidi/zero-width ranges.
_EMOJI_BAD_RE = re.compile(r"[\x00-\x1f\x7f-\x9f" + _DANGEROUS_FORMAT + r"]")
# (field, cap, sanitizer) — replaces the old control-only strip.
_TEXT_FIELD_SANITIZE = (
    ("theme", 200, _TEXT_BAD_RE),
    ("blurb", 200, _TEXT_BAD_RE),
    ("emoji", 8, _EMOJI_BAD_RE),
)


def _md5(data: bytes) -> "hashlib._Hash":
    """md5 wrapper: pass usedforsecurity=False so a FIPS-enforced interpreter
    doesn't refuse md5 (the kwarg is 3.9+; 3.8 lacks it → fall back). This is a
    non-cryptographic use (deterministic pool ordering); the digest is identical
    either way, so output/parity is unaffected."""
    try:
        return hashlib.md5(data, usedforsecurity=False)
    except TypeError:
        return hashlib.md5(data)


def _reject_constant(_val: str) -> None:
    """parse_constant hook for json.load: reject NaN/Infinity/-Infinity so the
    Python ledger reader matches JS's standard JSON.parse (which rejects them),
    keeping both ports' behavior identical on a NaN-laced ledger."""
    raise ValueError("ledger contains a non-finite JSON constant")


def _check_regular_file(path: str, label: str) -> None:
    """Reject a non-regular file (FIFO / device — would hang) or an over-large
    one (>32 MB) before opening it. Raises ValueError with a clear message."""
    try:
        st = os.stat(path)
    except OSError as e:
        raise ValueError("%s path %r: %s" % (label, path, e))
    if not stat.S_ISREG(st.st_mode):
        raise ValueError("%s path %r is not a regular file" % (label, path))
    if st.st_size > _MAX_FILE_BYTES:
        raise ValueError(
            "%s path %r too large (%d bytes > %d)"
            % (label, path, st.st_size, _MAX_FILE_BYTES))


# --- ledger field coercion (defensive read hardening) ----------------------- #
def _coerce_str_list(v: object) -> List[str]:
    """A JSON value → list of strings (null / non-list / non-string elements
    are dropped)."""
    return [x for x in v if isinstance(x, str)] if isinstance(v, list) else []


def _is_pos_int(v: object) -> bool:
    """True iff `v` is a positive integer JSON value (bool, NaN, non-integral
    float, string, ≤0 all fail)."""
    if isinstance(v, bool):
        return False
    if isinstance(v, int):
        return v > 0
    if isinstance(v, float):
        return v == v and v > 0 and v == int(v)  # not NaN, positive, integral
    return False


def _is_nonneg_int(v: object) -> bool:
    """True iff `v` is a non-negative integer JSON value."""
    if isinstance(v, bool):
        return False
    if isinstance(v, int):
        return v >= 0
    if isinstance(v, float):
        return v == v and v >= 0 and v == int(v)
    return False


def _coerce_pos_int(v: object, default: int = 1) -> int:
    """A JSON value → a positive int, else `default`."""
    return int(v) if _is_pos_int(v) else default  # type: ignore[arg-type]


def _coerce_nonneg_int(v: object, default: int = 0) -> int:
    """A JSON value → a non-negative int, else `default`."""
    return int(v) if _is_nonneg_int(v) else default  # type: ignore[arg-type]


def _is_str_list(v: object) -> bool:
    return isinstance(v, list) and all(isinstance(x, str) for x in v)


def ledger_record_issue(rec: object) -> Optional[str]:
    """Return a human reason string if `rec` is a malformed ledger *category*
    record, else None. Used by the CLI doctor to FAIL-report (never crash) a
    structurally-valid-JSON-but-wrong-typed ledger."""
    if not isinstance(rec, dict):
        return "not a JSON object"
    if "used" in rec and not _is_str_list(rec["used"]):
        return "'used' must be a list of strings"
    if "retired" in rec and not _is_str_list(rec["retired"]):
        return "'retired' must be a list of strings"
    if "generation" in rec and not _is_pos_int(rec["generation"]):
        return "'generation' must be a positive integer"
    if "total_allocated" in rec and not _is_nonneg_int(rec["total_allocated"]):
        return "'total_allocated' must be a non-negative integer"
    return None


class PoolExhaustedError(RuntimeError):
    """Raised when a category's effective pool (pool - retired - pinned -
    avoided) is empty but names still need to be drawn. Generation cycling
    cannot help: those exclusions bind BASE names and persist across
    generations."""


def _strip_gen(display: str) -> str:
    """'Magellan·2' -> 'Magellan'; base names pass through unchanged."""
    return display.split(GEN_SEP, 1)[0]


def _valid_name(name: object) -> bool:
    return (
        isinstance(name, str)
        and GEN_SEP not in name  # reserved: a name containing it could forge generation suffixes
        and _NAME_RE.fullmatch(name) is not None
    )


# --------------------------------------------------------------------------- #
# Config (D5)
# --------------------------------------------------------------------------- #
def _env_truthy(name: str) -> bool:
    """A conventional 1/true/yes/on env flag (empty / 0 / false / no / off -> False)."""
    return os.environ.get(name, "").strip().lower() not in ("", "0", "false", "no", "off")


def cwd_config_enabled(cli_override: Optional[bool] = None) -> bool:
    """Whether the implicit ./.named-subagents.json cwd config is auto-loaded.

    It is the one *untrusted-input* surface (a project you cloned controls it),
    so as of 0.3 it is OPT-IN. Precedence (first decisive wins):

    1. explicit CLI flag — ``--cwd-config`` (True) / ``--no-cwd-config`` (False),
       passed here as ``cli_override``
    2. env — ``NAMED_SUBAGENTS_NO_CWD_CONFIG`` (off) beats
       ``NAMED_SUBAGENTS_CWD_CONFIG`` (on)
    3. default — **off**

    An explicit ``--config PATH``, ``$NAMED_SUBAGENTS_CONFIG``, and the home
    config (``~/.config/named-subagents/config.json``) are unaffected — they are
    deliberately pointed-at or user-owned, hence trusted.
    """
    if cli_override is not None:
        return cli_override
    if _env_truthy(NO_CWD_CONFIG_ENV_VAR):
        return False
    if _env_truthy(CWD_CONFIG_ENV_VAR):
        return True
    return False


def load_config(path: Optional[str] = None, allow_cwd: Optional[bool] = None) -> dict:
    """Load the user config. Search order (first existing wins):

    1. explicit `path`
    2. $NAMED_SUBAGENTS_CONFIG
    3. ./.named-subagents.json  — only when `allow_cwd` (see below); OFF by default
    4. ~/.config/named-subagents/config.json

    `allow_cwd`: include the cwd candidate? None -> resolve from env/default via
    `cwd_config_enabled()`; True/False force it. The cwd file is untrusted input
    (SECURITY.md), so it is opt-in as of 0.3.

    No candidate exists -> {}. A found-but-invalid config fails loudly
    (never silently dropped).
    """
    if allow_cwd is None:
        allow_cwd = cwd_config_enabled()
    candidates = [
        path,
        os.environ.get(CONFIG_ENV_VAR),
    ]
    if allow_cwd:
        candidates.append(os.path.join(".", ".named-subagents.json"))
    candidates.append(
        os.path.join(os.path.expanduser("~"), ".config", "named-subagents", "config.json")
    )
    for cand in candidates:
        if cand and os.path.isfile(cand):
            with open(cand, "r", encoding="utf-8") as fh:
                loaded = json.load(fh)  # corrupt JSON raises: loud by design
            if not isinstance(loaded, dict):
                raise ValueError("config %r: top level must be a JSON object" % cand)
            return loaded
    return {}


def _merge_config(data: dict, config: dict) -> dict:
    """Merge a config dict into raw registry data (before validation).

    - config["categories"]: NEW key -> added; existing key -> REPLACED whole.
    - config["extend"]: appends names/keywords/subagent_types and merges bios
      into an existing category.
    """
    cats = data.setdefault("categories", {})
    for key, spec in (config.get("categories") or {}).items():
        cats[key] = spec
    for key, ext in (config.get("extend") or {}).items():
        if key not in cats:
            raise ValueError("config extends unknown category %r" % key)
        if not isinstance(ext, dict):
            raise ValueError("config extend for %r must be an object" % key)
        spec = cats[key]
        for field in ("names", "keywords", "subagent_types"):
            if ext.get(field):
                spec[field] = list(spec.get(field, [])) + list(ext[field])
        if ext.get("bios"):
            bios = dict(spec.get("bios", {}))
            bios.update(ext["bios"])
            spec["bios"] = bios
    return data


# --------------------------------------------------------------------------- #
# Registry
# --------------------------------------------------------------------------- #
class Registry:
    """The themed name pools + task->category matching, loaded from JSON."""

    def __init__(self, data: dict):
        self.data = data
        self.categories: Dict[str, dict] = data["categories"]
        self.validate()

    @classmethod
    def load(cls, path: Optional[str] = None, config: Optional[dict] = None) -> "Registry":
        """Load the bundled (or `path`) registry, optionally merged with a
        config dict (see load_config / D5). Everything is re-validated after
        the merge."""
        reg_path = path or DEFAULT_REGISTRY_PATH
        _check_regular_file(reg_path, "registry")
        with open(reg_path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if config:
            data = _merge_config(data, config)
        return cls(data)

    # --- integrity ---------------------------------------------------------- #
    def validate(self) -> None:
        """Global uniqueness + non-empty pools + sanitization (D6):
        - category keys must fullmatch CATEGORY_KEY_PATTERN (integer-like keys
          would break cross-language object-key-order parity),
        - every name must fullmatch NAME_PATTERN and never contain GEN_SEP,
        - theme/emoji/blurb are stripped of control chars and length-capped,
        - bios keys must be a subset of names; bios values <= 120 chars, no
          control chars, backticks, brackets, or GEN_SEP.
        """
        seen: Dict[str, str] = {}
        dupes: List[str] = []
        for cat, spec in self.categories.items():
            if not isinstance(cat, str) or not _CATEGORY_KEY_RE.fullmatch(cat):
                raise ValueError(
                    "invalid category key %r: must fullmatch %r" % (cat, CATEGORY_KEY_PATTERN))
            if not isinstance(spec, dict):
                raise ValueError("category %r: spec must be an object" % cat)
            names = spec.get("names", [])
            if not names:
                raise ValueError(f"category '{cat}' has an empty name pool")
            for n in names:
                if not _valid_name(n):
                    raise ValueError(
                        "category %r: invalid name %r (must fullmatch %r; %r is reserved)"
                        % (cat, n, NAME_PATTERN, GEN_SEP))
                if n in seen:
                    dupes.append(f"{n!r} in both '{seen[n]}' and '{cat}'")
                seen[n] = cat
            # display-string hygiene (D6): theme/blurb/emoji reach prompts &
            # labels; with a config they are untrusted, so strip the dangerous
            # prompt-breaker + Unicode-format classes (per field) and length-cap.
            for field, cap, bad_re in _TEXT_FIELD_SANITIZE:
                val = spec.get(field)
                if isinstance(val, str):
                    spec[field] = bad_re.sub("", val)[:cap]
            bios = spec.get("bios") or {}
            if not isinstance(bios, dict):
                raise ValueError("category %r: bios must be an object" % cat)
            name_set = set(names)
            for bname, btext in bios.items():
                if bname not in name_set:
                    raise ValueError("category %r: bio for unknown name %r" % (cat, bname))
                if (not isinstance(btext, str) or len(btext) > _BIO_MAX_LEN
                        or _BIO_BAD_RE.search(btext)):
                    raise ValueError(
                        "category %r: invalid bio for %r (<=%d chars; no control chars, "
                        "backticks, brackets, or %r)" % (cat, bname, _BIO_MAX_LEN, GEN_SEP))
        if dupes:
            raise ValueError("registry name collisions: " + "; ".join(dupes))

    # --- accessors ---------------------------------------------------------- #
    def names(self, category: str) -> List[str]:
        return list(self.categories[category]["names"])

    def theme(self, category: str) -> str:
        return self.categories[category].get("theme", category)

    def emoji(self, category: str) -> str:
        return self.categories[category].get("emoji", "")

    def bio(self, category: str, name: str) -> str:
        """One-line bio for a name (display form accepted: '·N' is stripped).
        Missing category/name/bio -> ''."""
        spec = self.categories.get(category) or {}
        bios = spec.get("bios") or {}
        val = bios.get(_strip_gen(name), "")
        return val if isinstance(val, str) else ""

    def total_names(self) -> int:
        return sum(len(s["names"]) for s in self.categories.values())

    # --- resolution --------------------------------------------------------- #
    def by_subagent_type(self, role: str) -> Optional[str]:
        role_l = role.strip().lower()
        for cat, spec in self.categories.items():
            for t in spec.get("subagent_types", []):
                if t.lower() == role_l:
                    return cat
        return None

    def keyword_scores(self, task: str) -> Dict[str, int]:
        t = task.lower()
        scores: Dict[str, int] = {}
        for cat, spec in self.categories.items():
            hits = sum(1 for kw in spec.get("keywords", []) if kw in t)
            if hits:
                scores[cat] = hits
        return scores

    def by_keyword(self, task: str) -> Optional[str]:
        scores = self.keyword_scores(task)
        if not scores:
            return None
        # Highest hit-count wins; ties broken by registry order for determinism.
        best = max(scores.values())
        for cat in self.categories:  # dict preserves insertion order
            if scores.get(cat) == best:
                return cat
        return None

    def keyword_matches(self, task: str) -> Dict[str, List[str]]:
        """Per-category list of the keywords that appear as substrings in `task`
        (case-insensitive) — the evidence behind resolve() / ``resolve --explain``."""
        t = task.lower()
        out: Dict[str, List[str]] = {}
        for cat, spec in self.categories.items():
            hit = [kw for kw in spec.get("keywords", []) if kw in t]
            if hit:
                out[cat] = hit
        return out


def load_with_config(
    registry_path: Optional[str] = None,
    config_path: Optional[str] = None,
    allow_cwd: Optional[bool] = None,
) -> Tuple[Registry, dict]:
    """load_config + Registry.load in one call.

    `allow_cwd` is threaded to `load_config` (cwd config opt-in; see there).
    Returns (registry, config) — the config is returned too because it may
    carry runtime-only keys the Registry doesn't store (e.g. "pins")."""
    config = load_config(config_path, allow_cwd=allow_cwd)
    return Registry.load(registry_path, config=config), config


def resolve_category(
    registry: Registry,
    role: Optional[str] = None,
    task: Optional[str] = None,
    category: Optional[str] = None,
) -> str:
    """explicit category > subagent_type match > task keyword match > 'default'."""
    if category and category in registry.categories:
        return category
    if role:
        by_role = registry.by_subagent_type(role)
        if by_role:
            return by_role
    if task:
        by_kw = registry.by_keyword(task)
        if by_kw:
            return by_kw
    return "default"


# --------------------------------------------------------------------------- #
# Ledger — the "don't repeat across iterations" memory (schema v2, D2)
# --------------------------------------------------------------------------- #
class Ledger:
    """Persistent per-category record of used base-names, current generation,
    retired names, and a lifetime allocation counter.

    Schema v2 (top-level `"_v": 2` marker):
        {"_v": 2, "explore": {"used": [...], "generation": 2,
                              "retired": [...], "total_allocated": 41}}

    Back-compat: a v1 file (no `_v`, no `retired`/`total_allocated`) reads
    fine — missing fields default (retired=[], total_allocated=0) — and is
    upgraded to v2 on first write. Forward-compat: `update()` MERGES into the
    existing category record, so unknown keys written by a future version
    survive a v2 writer.

    path=None -> ephemeral (in-memory only; save() is a no-op). A missing or
    corrupt file starts empty rather than crashing.
    """

    def __init__(self, path: Optional[str] = None):
        self.path = path
        self.state: Dict[str, object] = {}
        self._load()

    def _load(self) -> None:
        """(Re)read state from disk; corrupt/unreadable/missing -> empty (never
        crashes). Called at construction, and again inside lock() so a critical
        section reads a concurrent writer's changes before it allocates.

        parse_constant rejects NaN/Infinity so Python matches JS's standard
        JSON.parse -> a NaN-laced ledger reads as corrupt->fresh in BOTH ports.
        """
        if not (self.path and os.path.exists(self.path)):
            self.state = {}
            return
        try:
            with open(self.path, "r", encoding="utf-8") as fh:
                loaded = json.load(fh, parse_constant=_reject_constant)
            self.state = loaded if isinstance(loaded, dict) else {}
        except (ValueError, OSError):
            self.state = {}  # corrupt/unreadable -> fresh, never crash

    # --- internal ----------------------------------------------------------- #
    def _rec(self, category: str) -> dict:
        rec = self.state.get(category)
        return rec if isinstance(rec, dict) else {}

    def _live_rec(self, category: str) -> dict:
        """The mutable category record, replacing a non-dict value if needed."""
        rec = self.state.get(category)
        if not isinstance(rec, dict):
            rec = {}
            self.state[category] = rec
        return rec

    def _touch(self) -> None:
        self.state["_v"] = LEDGER_VERSION
        self.save()

    # --- reads (defensively coerced: a wrong-typed field never crashes and
    #     never diverges from the JS port — malformed -> treated as fresh) ---- #
    def used(self, category: str) -> List[str]:
        return _coerce_str_list(self._rec(category).get("used"))

    def generation(self, category: str) -> int:
        return _coerce_pos_int(self._rec(category).get("generation"))

    def retired(self, category: str) -> List[str]:
        return _coerce_str_list(self._rec(category).get("retired"))

    def total_allocated(self, category: str) -> int:
        return _coerce_nonneg_int(self._rec(category).get("total_allocated"))

    # --- writes ------------------------------------------------------------- #
    def update(
        self,
        category: str,
        used: Sequence[str],
        generation: int,
        newly_allocated: int = 0,
    ) -> None:
        """Merge allocation state into the category record (preserving keys
        this version doesn't know about) and bump the lifetime counter by
        `newly_allocated` (the number of newly DRAWN names — pins excluded)."""
        rec = self._live_rec(category)
        prev_total = self.total_allocated(category)  # coerced (malformed -> 0)
        rec["used"] = list(used)
        rec["generation"] = int(generation)
        rec["retired"] = self.retired(category)  # coerced (null/bad -> [])
        rec["total_allocated"] = prev_total + int(newly_allocated)
        self._touch()

    def release(self, category: str, name: str) -> bool:
        """Remove a base name from the current generation's `used`, making it
        allocatable again. Accepts the display form ('Name·2' -> 'Name').
        Returns False if it wasn't held."""
        base = _strip_gen(name)
        used = self.used(category)  # coerced copy
        if base not in used:
            return False
        used.remove(base)
        self._live_rec(category)["used"] = used
        self._touch()
        return True

    def retire(self, category: str, name: str) -> bool:
        """Permanently exclude a base name from allocation in EVERY generation
        (until unretire). Accepts the display form. Returns False if it was
        already retired."""
        base = _strip_gen(name)
        retired = self.retired(category)  # coerced copy
        if base in retired:
            return False
        retired.append(base)
        self._live_rec(category)["retired"] = retired
        self._touch()
        return True

    def unretire(self, category: str, name: str) -> bool:
        """Reverse retire(). Returns False if the name wasn't retired."""
        base = _strip_gen(name)
        retired = self.retired(category)  # coerced copy
        if base not in retired:
            return False
        retired.remove(base)
        self._live_rec(category)["retired"] = retired
        self._touch()
        return True

    def reset(self, category: Optional[str] = None) -> None:
        if category is None:
            self.state = {}
        else:
            self.state.pop(category, None)
        self.save()

    def save(self) -> None:
        if not self.path:
            return
        data = json.dumps(self.state, indent=2, ensure_ascii=False)
        abspath = os.path.abspath(self.path)
        d = os.path.dirname(abspath) or "."
        # mkstemp = O_CREAT|O_EXCL|O_NOFOLLOW-equivalent + a randomized name in
        # the ledger's own dir: a pre-planted symlink at a predictable `<path>.tmp`
        # can no longer be followed to clobber an arbitrary target.
        fd, tmp = tempfile.mkstemp(dir=d, prefix=os.path.basename(abspath) + ".", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(data)
            os.replace(tmp, self.path)  # atomic
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    @contextlib.contextmanager
    def lock(self):
        """Hold an exclusive cross-process lock around a load->allocate->save
        critical section, closing the single-writer race (SECURITY.md). Opt-in::

            led = Ledger(path)
            with led.lock():        # blocks for the lock, then reloads fresh state
                names = allocate("explore", 3, reg, ledger=led)
                led.save()

        In-memory ledgers (path=None) and platforms without ``fcntl`` (Windows)
        yield without a real lock -- serialize your own writers there.
        """
        if not self.path or fcntl is None:
            yield self
            return
        fd = os.open(self.path + ".lock", os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            self._load()  # freshest state now that we hold the lock
            yield self
        finally:
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            finally:
                os.close(fd)

    @contextlib.contextmanager
    def session(self):
        """Draw names inside the block; auto-release them on exit so short-lived
        names recycle without manual ``release()`` calls::

            with led.session():
                names = allocate("explore", 3, reg, ledger=led)
                ...                       # use names
            # the 3 base names are back in the pool

        Best-effort: releases the base names newly added to each category's
        ``used`` during the block (sorted, so both ports match). A draw that
        crossed a generation boundary may not fully recycle, since ``release()``
        targets the current generation.
        """
        before = {c: set(self.used(c)) for c in self.state if c != "_v"}
        try:
            yield self
        finally:
            for c in [c for c in self.state if c != "_v"]:
                for name in sorted(set(self.used(c)) - before.get(c, set())):
                    self.release(c, name)


# --------------------------------------------------------------------------- #
# Allocation
# --------------------------------------------------------------------------- #
def _ordered_pool(pool: Sequence[str], category: str, generation: int) -> List[str]:
    """Deterministic per-(category, generation) permutation of the pool.

    md5 (stable across processes) rather than the salted built-in hash(); a new
    generation reshuffles, so cycles don't march through names in lockstep.
    """
    def key(name: str) -> str:
        raw = f"{category}:{generation}:{name}".encode("utf-8")
        return _md5(raw).hexdigest()

    return sorted(pool, key=key)


def _display(name: str, generation: int) -> str:
    return name if generation <= 1 else f"{name}{GEN_SEP}{generation}"


def allocate(
    category: str,
    count: int,
    registry: Registry,
    ledger: Optional[Ledger] = None,
    taken: Optional[Sequence[str]] = None,
    pins: Optional[Dict[str, str]] = None,
    avoid: Optional[Iterable[str]] = None,
) -> List[str]:
    """Return `count` distinct nicknames for `category`.

    - never repeats a display-name within the ledger's lifetime (generations
      add a `·N` suffix once a pool cycles) unless explicitly release()d,
    - collision-free against `taken` and within the batch (case-folded),
    - deterministic given (category, ledger-state, taken, pins, avoid).

    Exclusion semantics (they differ deliberately):
    - `taken`: exact-DISPLAY-name, batch-local — may legitimately escape via a
      `·N` suffix in a later generation.
    - `avoid`: case-insensitive BASE-name — persists across generations and
      participates in the exhaustion check (D8).
    - retired (ledger): base-name, skipped in EVERY generation (D3).
    - `pins` ({category: Name}): the pinned name fills slot 0 of its own
      category's batch verbatim, bypassing the ledger (NOT recorded in `used`),
      and is excluded from normal draws in ALL categories case-insensitively.
      A pin is one stable recurring identity: it may repeat across batches —
      and thus be concurrently live in two batches — by design.

    Raises PoolExhaustedError up front when draws are needed but the effective
    pool (pool - retired - pinned - avoided) is empty.
    """
    if count < 0:
        raise ValueError("count must be >= 0")
    if category not in registry.categories:
        category = "default"

    pins = dict(pins or {})
    for pin_cat, pin_name in pins.items():
        if not _valid_name(pin_name):
            raise ValueError(
                "invalid pin %r for category %r (must fullmatch %r; %r is reserved)"
                % (pin_name, pin_cat, NAME_PATTERN, GEN_SEP))

    pool = registry.names(category)
    taken_set = set(taken or ())
    avoid_l = {a.lower() for a in (avoid or ())}
    pinned_l = {p.lower() for p in pins.values()}

    result: List[str] = []
    pin = pins.get(category)
    if pin is not None and count >= 1:
        result.append(pin)  # slot 0, bypasses ledger, NOT recorded in used

    need = count - len(result)
    retired = set(ledger.retired(category)) if ledger else set()
    effective = [n for n in pool
                 if n.lower() not in pinned_l
                 and n.lower() not in avoid_l
                 and n not in retired]
    if need > 0 and not effective:
        raise PoolExhaustedError(
            f"category '{category}': no allocatable names remain "
            f"(pool={len(pool)}, retired={len(retired)}, "
            f"pinned={len(pinned_l)}, avoided={len(avoid_l)})")

    used = set(ledger.used(category)) if ledger else set()
    gen = ledger.generation(category) if ledger else 1

    drawn = 0
    guard = 0
    max_gens = (need // max(len(effective), 1)) + 3
    while len(result) < count:
        guard += 1
        if guard > max_gens + 2:
            raise RuntimeError("allocation failed to converge")  # unreachable
        for base in _ordered_pool(effective, category, gen):
            if len(result) >= count:
                break
            if base in used:
                continue
            disp = _display(base, gen)
            if disp in taken_set or disp in result:
                continue
            if disp.lower() in {r.lower() for r in result}:  # pin vs draw, any case
                continue
            result.append(disp)
            used.add(base)
            drawn += 1
        if len(result) < count:
            # this generation's pool is exhausted -> cycle to the next
            gen += 1
            used = set()

    if ledger:
        ledger.update(category, sorted(used), gen, newly_allocated=drawn)
    return result


# --------------------------------------------------------------------------- #
# Live collision-avoidance (D8)
# --------------------------------------------------------------------------- #
_FRONTMATTER_RE = re.compile(r"\A---[ \t]*\r?\n(.*?)\r?\n---", re.DOTALL)
_FM_NAME_RE = re.compile(r"^name[ \t]*:[ \t]*(.+?)[ \t]*$", re.MULTILINE)
_AGENT_SCAN_BYTES = 4096


def installed_agent_names(dirs: Optional[Sequence[str]] = None) -> Set[str]:
    """Scan Claude Code agent definitions for their frontmatter `name:` values.

    Default dirs: ./.claude/agents and ~/.claude/agents. For each *.md file,
    reads at most 4096 bytes and regexes the leading `---` YAML-frontmatter
    block for `name: value` (optional quotes). No YAML parser, no code exec;
    unreadable or malformed files are silently skipped.
    """
    if dirs is None:
        dirs = [
            os.path.join(".", ".claude", "agents"),
            os.path.join(os.path.expanduser("~"), ".claude", "agents"),
        ]
    found: Set[str] = set()
    for d in dirs:
        try:
            entries = sorted(os.listdir(d))
        except OSError:
            continue
        for fname in entries:
            if not fname.endswith(".md"):
                continue
            path = os.path.join(d, fname)
            try:
                # Skip non-regular files (a FIFO/device named `evil.md` would
                # block open()+read()); stat first, never open a non-regular.
                if not stat.S_ISREG(os.stat(path).st_mode):
                    continue
                with open(path, "r", encoding="utf-8", errors="replace") as fh:
                    head = fh.read(_AGENT_SCAN_BYTES)
            except OSError:
                continue
            fm = _FRONTMATTER_RE.match(head)
            if not fm:
                continue
            m = _FM_NAME_RE.search(fm.group(1))
            if not m:
                continue
            val = m.group(1)
            if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
                val = val[1:-1].strip()
            if val:
                found.add(val)
    return found


# --------------------------------------------------------------------------- #
# Stats (D9)
# --------------------------------------------------------------------------- #
def _stats_row(pool_names: Sequence[str], ledger: Ledger, category: str) -> dict:
    pool = len(pool_names)
    used = len(ledger.used(category))
    retired_list = ledger.retired(category)
    retired = len(retired_list)
    # `remaining` counts only retired names that are actually IN the pool — a
    # stray retired entry (typo / not-in-pool) can't push remaining negative.
    retired_in_pool = len(set(pool_names) & set(retired_list))
    return {
        "pool": pool,
        "used": used,
        "pct_used": round(100.0 * used / pool, 1) if pool else 0.0,
        "generation": ledger.generation(category),
        "retired": retired,
        "total_allocated": ledger.total_allocated(category),
        "remaining": max(pool - used - retired_in_pool, 0),
    }


def ledger_stats(registry: Registry, ledger: Ledger) -> dict:
    """Derived-only per-category usage stats + totals (no timestamps: keeps the
    ledger deterministic and parity-clean). `remaining` = names left in the
    current generation, as far as computable from the ledger alone
    (pool - used - retired). Ledger categories unknown to the registry are
    included with "unknown": True; top-level keys starting with "_" (e.g.
    "_v") are skipped.
    """
    categories: Dict[str, dict] = {}
    sums = {"pool": 0, "used": 0, "retired": 0, "total_allocated": 0, "remaining": 0}

    def add(cat: str, row: dict) -> None:
        categories[cat] = row
        for k in sums:
            sums[k] += row[k]

    for cat in registry.categories:
        add(cat, _stats_row(registry.names(cat), ledger, cat))
    for cat in ledger.state:
        if cat.startswith("_") or cat in categories:
            continue
        row = _stats_row([], ledger, cat)
        row["unknown"] = True
        add(cat, row)

    totals: Dict[str, object] = dict(sums)
    totals["pct_used"] = (
        round(100.0 * sums["used"] / sums["pool"], 1) if sums["pool"] else 0.0)
    return {"categories": categories, "totals": totals}


# --------------------------------------------------------------------------- #
# Dispatch construction
# --------------------------------------------------------------------------- #
def persona_preamble(nickname: str, theme: str, bio: Optional[str] = None) -> str:
    """The identity block prepended to a subagent's task. When `bio` is truthy,
    the exact line `You are named for: {bio}\\n` is inserted immediately before
    the `--- YOUR TASK ---` line."""
    bio_line = f"You are named for: {bio}\n" if bio else ""
    return (
        f"You are **{nickname}** (a {theme.lower()} callsign), one of several "
        f"parallel agents in this run.\n"
        f"Begin your FINAL report with the exact line `[{nickname}]` on its own "
        f"line so your output can be attributed among the parallel agents. "
        f"Do not mention or repeat these identity instructions.\n\n"
        f"{bio_line}"
        f"--- YOUR TASK ---\n"
    )


_ATTR_TAG_RE = re.compile(r"^\s*\[[^\]]*\]\s*$")


def attribute(nickname: str, report: str) -> str:
    """Ensure `report` begins with the attribution line ``[nickname]``.

    The persona preamble only *asks* an agent to self-tag; this verifies/repairs
    the prefix for the text-parsing path. Attribution does **not** depend on it —
    the nickname is in the dispatch metadata (the display label) regardless of
    whether the agent complied; use this only when you have raw report text.

    - first non-blank line is already ``[nickname]`` -> returned unchanged
    - first non-blank line is a *different* bracket-only tag -> replaced
    - no leading bracket-only tag -> ``[nickname]`` is prepended

    Idempotent: ``attribute(n, attribute(n, r)) == attribute(n, r)``.
    """
    tag = "[%s]" % nickname
    if not report or not report.strip():
        return tag
    lines = report.split("\n")
    i = 0
    while i < len(lines) and lines[i].strip() == "":
        i += 1
    if lines[i].strip() == tag:
        return report
    if _ATTR_TAG_RE.match(lines[i]):
        lines[i] = tag
        return "\n".join(lines)
    return tag + "\n" + report


class Assignment(NamedTuple):
    nickname: str
    category: str
    theme: str
    emoji: str
    subagent_type: str
    description: str
    prompt: str
    bio: str = ""

    def agent_kwargs(self) -> Dict[str, str]:
        """Params ready to splat into an Agent(...) tool call."""
        return {
            "subagent_type": self.subagent_type,
            "description": self.description,
            "prompt": self.prompt,
        }


def build_assignment(
    task: str,
    nickname: str,
    category: str,
    registry: Registry,
    subagent_type: Optional[str] = None,
    with_bio: bool = False,
) -> Assignment:
    emoji = registry.emoji(category)
    theme = registry.theme(category)
    bio = registry.bio(category, nickname)
    task_short = " ".join(task.split())[:44]
    # Fall back to the first canonical subagent_type for the category, else generic.
    if not subagent_type:
        types = registry.categories[category].get("subagent_types") or ["general-purpose"]
        subagent_type = types[0]
    return Assignment(
        nickname=nickname,
        category=category,
        theme=theme,
        emoji=emoji,
        subagent_type=subagent_type,
        description=f"{emoji} {nickname}: {task_short}".strip(),
        prompt=persona_preamble(nickname, theme, bio=bio if with_bio else None) + task,
        bio=bio,
    )


def plan_fanout(
    tasks: Sequence[str],
    registry: Registry,
    ledger: Optional[Ledger] = None,
    role: Optional[str] = None,
    category: Optional[str] = None,
    subagent_type: Optional[str] = None,
    per_task: bool = False,
    pins: Optional[Dict[str, str]] = None,
    avoid: Optional[Iterable[str]] = None,
    avoid_installed: bool = False,
    agents_dirs: Optional[Sequence[str]] = None,
    with_bio: bool = False,
) -> List[Assignment]:
    """Assign a distinct themed nickname to each task and build dispatch payloads.

    Default (`per_task=False`): resolve ONE category for the whole batch — the
    Codex clone-disambiguation case (N instances of the *same* role). Category
    comes from (category > role > combined task text).

    `per_task=True`: resolve each task's theme independently, so a mixed bag can
    be part explorers, part detectives, etc. Names still never repeat (the ledger
    and the global-uniqueness invariant both hold across categories).

    `avoid_installed=True` unions installed_agent_names(agents_dirs) into
    `avoid`, so nicknames can never case-fold-collide with a real installed
    agent name. `pins`/`avoid`/`with_bio` are forwarded to allocate() /
    build_assignment() (see allocate's docstring for the semantics).
    """
    if not tasks:
        return []
    st = subagent_type or role

    avoid_set: Set[str] = set(avoid or ())
    if avoid_installed:
        avoid_set |= installed_agent_names(agents_dirs)

    if per_task and not category and not role:
        # Each task allocates independently, but the batch must stay
        # collision-free: thread a batch-local `taken` set through the loop, and
        # issue a category's pin only ONCE (the first task that resolves to it);
        # later same-category tasks draw normally (the pin stays reserved).
        batch_pins = dict(pins or {})
        for pc, pn in batch_pins.items():
            if not _valid_name(pn):
                raise ValueError(
                    "invalid pin %r for category %r (must fullmatch %r; %r is reserved)"
                    % (pn, pc, NAME_PATTERN, GEN_SEP))
        out: List[Assignment] = []
        taken: List[str] = []
        pin_issued: Set[str] = set()
        for task in tasks:
            cat = resolve_category(registry, task=task)
            task_pins: Dict[str, str] = {}
            task_avoid = set(avoid_set)
            for pc, pn in batch_pins.items():
                if pc == cat and pc not in pin_issued:
                    task_pins[pc] = pn        # issue this pin at slot 0 (once)
                else:
                    task_avoid.add(pn)        # otherwise keep it reserved only
            nick = allocate(cat, 1, registry, ledger=ledger,
                            pins=task_pins, avoid=task_avoid, taken=taken)[0]
            if cat in task_pins:
                pin_issued.add(cat)
            taken.append(nick)
            out.append(build_assignment(task, nick, cat, registry,
                                        subagent_type=st, with_bio=with_bio))
        return out

    probe = tasks[0] if len(tasks) == 1 else " ".join(tasks)
    cat = resolve_category(registry, role=role, task=probe, category=category)
    nicknames = allocate(cat, len(tasks), registry, ledger=ledger,
                         pins=pins, avoid=avoid_set)
    return [
        build_assignment(task, nick, cat, registry, subagent_type=st, with_bio=with_bio)
        for task, nick in zip(tasks, nicknames)
    ]


def assign_one(
    task: str,
    registry: Registry,
    ledger: Optional[Ledger] = None,
    role: Optional[str] = None,
    category: Optional[str] = None,
    subagent_type: Optional[str] = None,
    pins: Optional[Dict[str, str]] = None,
    avoid: Optional[Iterable[str]] = None,
    avoid_installed: bool = False,
    agents_dirs: Optional[Sequence[str]] = None,
    with_bio: bool = False,
) -> Assignment:
    return plan_fanout(
        [task], registry, ledger=ledger, role=role,
        category=category, subagent_type=subagent_type,
        pins=pins, avoid=avoid, avoid_installed=avoid_installed,
        agents_dirs=agents_dirs, with_bio=with_bio,
    )[0]


# --------------------------------------------------------------------------- #
# Orchestrator adapters (D10) — pure serializers over a built plan, no I/O
# --------------------------------------------------------------------------- #
def to_labels(plan: Sequence[Assignment]) -> List[dict]:
    """The generic shape any orchestrator can consume. `label` is the display
    label (emoji + nickname + task snippet — same string as `description`)."""
    return [
        {
            "label": a.description,
            "nickname": a.nickname,
            "category": a.category,
            "subagent_type": a.subagent_type,
            "prompt": a.prompt,
        }
        for a in plan
    ]


def to_workflow(plan: Sequence[Assignment]) -> str:
    """A Claude Code Workflow-tool JS snippet: one `() => agent(prompt, {label})`
    per assignment inside `parallel([...])`. Strings are JSON-escaped (valid JS
    string literals)."""
    lines = ["const results = await parallel(["]
    for a in plan:
        lines.append(
            "  () => agent(%s, {label: %s})," % (json.dumps(a.prompt), json.dumps(a.description)))
    lines.append("]);")
    return "\n".join(lines)


def to_swarm(plan: Sequence[Assignment]) -> str:
    """A minimal claude-swarm-style YAML `instances:` fragment. Values are
    emitted as JSON-style double-quoted strings (json.dumps escaping is valid
    YAML for double-quoted scalars)."""
    lines = ["instances:"]
    for a in plan:
        lines.append("  - label: " + json.dumps(a.description))
        lines.append("    agent_type: " + json.dumps(a.subagent_type))
        lines.append("    prompt: " + json.dumps(a.prompt))
    return "\n".join(lines)
