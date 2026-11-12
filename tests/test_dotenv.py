import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from robust_pwd import dotenv  # noqa: E402

FIXTURES = ROOT / "tests" / "fixtures" / "dotenv"


def _read(path: Path) -> str:
    return path.read_bytes().decode("utf-8")


class DotenvFixturesTest(unittest.TestCase):
    def test_parse_fixtures(self):
        cases = sorted(FIXTURES.glob("*.env"))
        cases = [c for c in cases if not c.name.startswith("serialize.")]
        self.assertGreater(len(cases), 5)
        for case in cases:
            with self.subTest(fixture=case.name):
                expected = json.loads(_read(case.with_name(case.stem + ".expected.json")))
                self.assertEqual(dotenv.parse(_read(case)), expected)

    def test_serialize_fixtures(self):
        variables = json.loads(_read(FIXTURES / "serialize.input.json"))
        for fmt, ext in (("dotenv", "env"), ("shell", "sh"), ("json", "json")):
            with self.subTest(fmt=fmt):
                expected = _read(FIXTURES / f"serialize.expected.{ext}")
                self.assertEqual(dotenv.serialize(variables, fmt), expected)

    def test_roundtrip(self):
        variables = json.loads(_read(FIXTURES / "serialize.input.json"))
        variables.append({"key": "TRAILING_BACKSLASH", "value": "a\\"})
        variables.append({"key": "CR", "value": "a\rb"})
        variables.append({"key": "SPACES", "value": "  padded  "})
        parsed = dotenv.parse(dotenv.serialize(variables))
        self.assertEqual(parsed["variables"], variables)
        self.assertEqual(parsed["invalid_lines"], [])

    def test_unknown_format(self):
        with self.assertRaises(ValueError):
            dotenv.serialize([], "yaml")


if __name__ == "__main__":
    unittest.main()

