"""Lecture et écriture de fichiers ``.env`` (voir docs/secrets-format.md, §3).

Implémentation jumelle de ``desktop/src/main/dotenv.ts`` : les deux doivent produire
exactement les mêmes résultats sur ``tests/fixtures/dotenv/``.
"""

import json
import re
from typing import Dict, List

_KEY_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)[ \t]*=")
_EXPORT_RE = re.compile(r"^export[ \t]+")
_PLAIN_RE = re.compile(r"^[A-Za-z0-9_./:@%+,=-]*$")
_DQ_ESCAPES = {"n": "\n", "r": "\r", "t": "\t", '"': '"', "\\": "\\"}


def _rest_is_comment(rest: str) -> bool:
    stripped = rest.lstrip(" \t")
    if not stripped:
        return True
    return stripped.startswith("#") and len(stripped) < len(rest)


def _read_quoted(lines: List[str], index: int, start: int, quote: str):
    """Lit une valeur entre guillemets à partir de ``lines[index][start]`` (après le guillemet).

    Retourne ``(valeur, index_ligne_fin, reste_de_ligne)`` ou ``None`` si jamais fermée.
    """
    out = []
    i = index
    pos = start
    while i < len(lines):
        line = lines[i]
        while pos < len(line):
            ch = line[pos]
            if quote == '"' and ch == "\\" and pos + 1 < len(line):
                nxt = line[pos + 1]
                if nxt in _DQ_ESCAPES:
                    out.append(_DQ_ESCAPES[nxt])
                else:
                    out.append(ch + nxt)
                pos += 2
                continue
            if ch == quote:
                return "".join(out), i, line[pos + 1:]
            out.append(ch)
            pos += 1
        out.append("\n")
        i += 1
        pos = 0
    return None


def parse(text: str) -> Dict[str, object]:
    if text.startswith("\ufeff"):
        text = text[1:]
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = text.split("\n")

    values: Dict[str, str] = {}
    order: List[str] = []
    duplicates: List[str] = []
    invalid: List[int] = []

    def store(key: str, value: str) -> None:
        if key in values:
            if key not in duplicates:
                duplicates.append(key)
        else:
            order.append(key)
        values[key] = value

    i = 0
    while i < len(lines):
        number = i + 1
        line = lines[i].lstrip(" \t")
        if not line or line.startswith("#"):
            i += 1
            continue
        line = _EXPORT_RE.sub("", line, count=1)
        match = _KEY_RE.match(line)
        if not match:
            invalid.append(number)
            i += 1
            continue
        key = match.group(1)
        raw = line[match.end():]
        stripped = raw.lstrip(" \t")

        if stripped[:1] in ('"', "'"):
            quote = stripped[0]
            offset = len(lines[i]) - len(stripped) + 1
            result = _read_quoted(lines, i, offset, quote)
            if result is None:
                invalid.append(number)
                i += 1
                continue
            value, end_index, rest = result
            if not _rest_is_comment(rest):
                invalid.append(number)
                i = end_index + 1
                continue
            store(key, value)
            i = end_index + 1
            continue

        cut = len(raw)
        for pos, ch in enumerate(raw):
            if ch == "#" and pos > 0 and raw[pos - 1] in " \t":
                cut = pos
                break
        store(key, raw[:cut].strip(" \t"))
        i += 1

    return {
        "variables": [{"key": k, "value": values[k]} for k in order],
        "duplicates": duplicates,
        "invalid_lines": invalid,
    }


def _format_value(value: str) -> str:
    if value == "":
        return ""
    if _PLAIN_RE.match(value):
        return value
    if "'" not in value and "\n" not in value and "\r" not in value:
        return f"'{value}'"
    escaped = (
        value.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\n", "\\n")
        .replace("\r", "\\r")
        .replace("\t", "\\t")
    )
    return f'"{escaped}"'


def serialize(variables: List[Dict[str, str]], fmt: str = "dotenv") -> str:
    if fmt == "dotenv":
        return "".join(f"{v['key']}={_format_value(v['value'])}\n" for v in variables)
    if fmt == "shell":
        return "".join(
            "export {}='{}'\n".format(v["key"], v["value"].replace("'", "'\\''")) for v in variables
        )
    if fmt == "json":
        return json.dumps({v["key"]: v["value"] for v in variables}, ensure_ascii=False, indent=2) + "\n"
    raise ValueError(f"Format inconnu : « {fmt} » (attendu : dotenv, shell, json).")

