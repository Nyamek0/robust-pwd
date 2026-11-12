import base64
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from cryptography.hazmat.primitives.asymmetric import x25519

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from robust_pwd import cli, secrets_vault, sync, vault  # noqa: E402
from robust_pwd.project_file import (  # noqa: E402
    find_project_file,
    is_git_ignored,
    resolve_project_and_env,
    write_project_file,
)
from robust_pwd.providers import (  # noqa: E402
    GitHubProvider,
    GitLabProvider,
    ProviderError,
    open_sealed_box,
    seal_box,
)
from robust_pwd.secrets_vault import SecretsVaultError  # noqa: E402

MASTER = "correct horse battery staple"


class SecretsVaultTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "secrets.enc"

    def tearDown(self):
        self.tmp.cleanup()

    def test_create_load_and_project_lifecycle(self):
        doc = secrets_vault.create_secrets_vault(MASTER, self.path)
        self.assertEqual(doc["kind"], "robust-pwd/secrets")
        self.assertEqual(doc["version"], 1)

        proj = secrets_vault.add_project(doc, "mon-api", description="Backend")
        self.assertEqual(proj["id"], 1)
        self.assertEqual([e["name"] for e in proj["environments"]], ["local", "staging", "production"])

        secrets_vault.set_variable(
            doc, "mon-api", "local", "DATABASE_URL", "postgresql://localhost/app", masked=True
        )
        secrets_vault.save_secrets_vault(doc, MASTER, self.path)

        reloaded = secrets_vault.load_secrets_vault(MASTER, self.path)
        var = secrets_vault.get_variable(reloaded, "mon-api", "local", "DATABASE_URL")
        self.assertEqual(var["value"], "postgresql://localhost/app")
        self.assertTrue(var["masked"])

        secrets_vault.unset_variable(reloaded, "mon-api", "local", "DATABASE_URL")
        self.assertEqual(reloaded["projects"][0]["environments"][0]["variables"], [])

    def test_rejects_password_vault_kind(self):
        pwd_path = Path(self.tmp.name) / "vault.enc"
        vault.save_vault({"entries": []}, MASTER, pwd_path)
        with self.assertRaises(SecretsVaultError) as ctx:
            secrets_vault.load_secrets_vault(MASTER, pwd_path)
        self.assertEqual(ctx.exception.code, "WRONG_KIND")

    def test_validation_errors(self):
        with self.assertRaises(SecretsVaultError):
            secrets_vault.create_secrets_vault("court", self.path)

        doc = secrets_vault.empty_vault()
        with self.assertRaises(SecretsVaultError):
            secrets_vault.add_project(doc, "invalid space")
        secrets_vault.add_project(doc, "app")
        with self.assertRaises(SecretsVaultError):
            secrets_vault.add_project(doc, "app")
        with self.assertRaises(SecretsVaultError):
            secrets_vault.add_environment(doc, "app", "UPPER")
        with self.assertRaises(SecretsVaultError):
            secrets_vault.set_variable(doc, "app", "local", "1BAD", "v")
        with self.assertRaises(SecretsVaultError):
            secrets_vault.link_remote(doc, "app", "gitlab", "group/proj", host="http://insecure.local")

    def test_import_variables_overwrite_and_skip(self):
        doc = secrets_vault.empty_vault()
        secrets_vault.add_project(doc, "app")
        pairs = [{"key": "A", "value": "1"}, {"key": "B", "value": "2"}]
        self.assertEqual(secrets_vault.import_variables(doc, "app", "local", pairs), (2, 0, 0))
        pairs2 = [{"key": "A", "value": "1"}, {"key": "B", "value": "3"}, {"key": "C", "value": "4"}]
        self.assertEqual(
            secrets_vault.import_variables(doc, "app", "local", pairs2, overwrite=False),
            (1, 0, 2),
        )
        self.assertEqual(
            secrets_vault.import_variables(doc, "app", "local", pairs2, overwrite=True),
            (0, 1, 2),
        )


class ProjectFileTest(unittest.TestCase):
    def test_find_and_resolve(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".git").mkdir()
            write_project_file("mon-api", "staging", root)
            sub = root / "src" / "deep"
            sub.mkdir(parents=True)
            found = find_project_file(sub)
            self.assertIsNotNone(found)
            self.assertEqual(resolve_project_and_env(None, None, sub), ("mon-api", "staging"))
            self.assertEqual(resolve_project_and_env(None, "production", sub), ("mon-api", "production"))
            self.assertEqual(resolve_project_and_env("autre", None, sub), ("autre", "staging"))

    def test_git_ignored(self):
        self.assertTrue(is_git_ignored(ROOT / ".env"))
        self.assertFalse(is_git_ignored(ROOT / "README.md"))


class SyncAndProvidersTest(unittest.TestCase):
    def test_gitlab_plan_and_validation(self):
        local_vars = [
            {"key": "NEW_KEY", "value": "abcdefgh", "masked": True, "protected": False, "raw": True, "type": "env_var"},
            {"key": "SAME_KEY", "value": "12345678", "masked": False, "protected": False, "raw": True, "type": "env_var"},
            {"key": "CHANGED_KEY", "value": "newval123", "masked": False, "protected": True, "raw": True, "type": "env_var"},
        ]
        remote_vars = [
            {"key": "SAME_KEY", "value": "12345678", "masked": False, "protected": False, "raw": True, "type": "env_var"},
            {"key": "CHANGED_KEY", "value": "oldval123", "masked": False, "protected": True, "raw": True, "type": "env_var"},
            {"key": "OLD_REMOTE", "value": "xyz", "masked": False, "protected": False, "raw": True, "type": "env_var"},
        ]
        plan = sync.build_sync_plan(
            provider="gitlab",
            target="grp/app",
            environment="production",
            scope="production",
            local_vars=local_vars,
            remote_vars=remote_vars,
            prune=True,
        )
        self.assertEqual(plan["errors"], [])
        self.assertEqual(
            [(i["key"], i["action"]) for i in plan["items"]],
            [
                ("NEW_KEY", "create"),
                ("CHANGED_KEY", "update"),
                ("OLD_REMOTE", "delete"),
                ("SAME_KEY", "unchanged"),
            ],
        )

        bad_local = [{"key": "SHORT_MASK", "value": "abc", "masked": True}]
        self.assertTrue(sync.validate_for_provider("gitlab", bad_local))

    def test_github_plan_and_validation(self):
        local_vars = [
            {"key": "api_key", "value": "secret"},
            {"key": "NEW_ONE", "value": "val"},
        ]
        remote_vars = [
            {"key": "API_KEY", "value": None},
            {"key": "ORPHAN", "value": None},
        ]
        plan = sync.build_sync_plan(
            provider="github",
            target="owner/repo",
            environment="production",
            scope="*",
            local_vars=local_vars,
            remote_vars=remote_vars,
            prune=False,
        )
        self.assertEqual(plan["errors"], [])
        self.assertEqual(
            [(i["key"], i["action"]) for i in plan["items"]],
            [
                ("NEW_ONE", "create"),
                ("API_KEY", "overwrite"),
                ("ORPHAN", "keep"),
            ],
        )

        self.assertTrue(sync.validate_for_provider("github", [{"key": "GITHUB_TOKEN", "value": "x"}]))

    def test_seal_box_roundtrip(self):
        sk = x25519.X25519PrivateKey.generate()
        pk_b64 = base64.b64encode(sk.public_key().public_bytes_raw()).decode("ascii")
        sealed = seal_box("secret GitHub 🚀".encode("utf-8"), pk_b64)
        opened = open_sealed_box(sealed, sk.private_bytes_raw())
        self.assertEqual(opened.decode("utf-8"), "secret GitHub 🚀")

    def test_gitlab_provider_mock_http(self):
        calls = []

        def fake_transport(method, url, headers, body):
            calls.append((method, url, json.loads(body.decode()) if body else None))
            if url.endswith("/user"):
                return 200, {}, json.dumps({"username": "alice"}).encode()
            if method == "GET" and "/variables" in url:
                return 200, {"x-next-page": ""}, json.dumps([
                    {"key": "A", "value": "1", "environment_scope": "production",
                     "masked": False, "protected": False, "raw": True, "variable_type": "env_var"},
                    {"key": "OTHER", "value": "2", "environment_scope": "staging"},
                ]).encode()
            return 200, {}, b"{}"

        client = GitLabProvider("https://gitlab.example.com", "glpat-xxx", transport=fake_transport)
        self.assertEqual(client.verify_token(), "alice")
        vars_prod = client.list_remote("group/sub/app", "production")
        self.assertEqual(len(vars_prod), 1)
        self.assertEqual(vars_prod[0]["key"], "A")

        summary = client.apply_plan(
            "group/sub/app",
            "production",
            [{"key": "B", "value": "2", "masked": True, "protected": False, "raw": True, "type": "env_var"}],
            [{"key": "B", "action": "create"}, {"key": "A", "action": "delete"}],
        )
        self.assertEqual(summary, {"created": 1, "updated": 0, "deleted": 1})

    def test_github_provider_mock_http(self):
        sk = x25519.X25519PrivateKey.generate()
        pk_b64 = base64.b64encode(sk.public_key().public_bytes_raw()).decode("ascii")
        put_payloads = []

        def fake_transport(method, url, headers, body):
            if url.endswith("/user"):
                return 200, {}, json.dumps({"login": "octocat"}).encode()
            if url.endswith("/public-key"):
                return 200, {}, json.dumps({"key_id": "kid-1", "key": pk_b64}).encode()
            if method == "GET" and "/actions/secrets" in url:
                return 200, {}, json.dumps({"total_count": 1, "secrets": [{"name": "EXISTING"}]}).encode()
            if method == "PUT":
                put_payloads.append(json.loads(body.decode()))
                return 204, {}, b""
            return 204, {}, b""

        client = GitHubProvider("https://api.github.com", "ghp_xxx", transport=fake_transport)
        self.assertEqual(client.verify_token(), "octocat")
        rem = client.list_remote("owner/repo", "*")
        self.assertEqual(len(rem), 1)
        self.assertEqual(rem[0]["key"], "EXISTING")

        summary = client.apply_plan(
            "owner/repo",
            "*",
            [{"key": "API_KEY", "value": "topsecret"}],
            [{"key": "API_KEY", "action": "create"}],
        )
        self.assertEqual(summary["created"], 1)
        self.assertEqual(put_payloads[0]["key_id"], "kid-1")
        decrypted = open_sealed_box(put_payloads[0]["encrypted_value"], sk.private_bytes_raw())
        self.assertEqual(decrypted, b"topsecret")


class CliSecretsEndToEndTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.vault_file = Path(self.tmp.name) / "secrets.enc"
        self.env_patch = mock.patch.dict(
            os.environ,
            {"ROBUST_PWD_SECRETS_VAULT": str(self.vault_file)},
        )
        self.env_patch.start()

    def tearDown(self):
        self.env_patch.stop()
        self.tmp.cleanup()

    def _run_cli(self, argv, stdin_text=""):
        with mock.patch.object(sys, "stdin", io.StringIO(stdin_text)):
            cli.main(argv)

    def test_cli_workflow_and_run_injection(self):
        self._run_cli(["secrets", "--master-stdin", "init"], f"{MASTER}\n")
        self._run_cli(["secrets", "--master-stdin", "project", "add", "demo"], f"{MASTER}\n")

        with mock.patch("getpass.getpass", side_effect=[MASTER, "super_secret_val"]):
            cli.main(["secrets", "set", "demo", "local", "APP_SECRET", "--masked"])

        # Refuse KEY=value en argument
        with self.assertRaises(SystemExit):
            self._run_cli(["secrets", "--master-stdin", "set", "demo", "local", "BAD=1"], f"{MASTER}\n")

        out_marker = Path(self.tmp.name) / "injected.txt"
        py_cmd = (
            f"import os, pathlib; "
            f"pathlib.Path({str(out_marker)!r}).write_text(os.environ.get('APP_SECRET', ''), encoding='utf-8')"
        )
        self._run_cli(
            ["secrets", "--master-stdin", "run", "demo", "local", "--", sys.executable, "-c", py_cmd],
            f"{MASTER}\n",
        )
        self.assertEqual(out_marker.read_text(encoding="utf-8"), "super_secret_val")


if __name__ == "__main__":
    unittest.main()

