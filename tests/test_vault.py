import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from robust_pwd import crypto, vault  # noqa: E402
from robust_pwd.generator import generate_apple, generate_google, generate_secret  # noqa: E402

MASTER = "correct horse battery staple"


class CryptoTest(unittest.TestCase):
    def test_roundtrip(self):
        blob = crypto.encrypt("données ☕".encode(), MASTER)
        self.assertEqual(crypto.decrypt(blob, MASTER).decode(), "données ☕")

    def test_wrong_master(self):
        blob = crypto.encrypt(b"x", MASTER)
        with self.assertRaises(Exception):
            crypto.decrypt(blob, "mauvais")

    def test_tampered(self):
        blob = bytearray(crypto.encrypt(b"x", MASTER))
        blob[-1] ^= 1
        with self.assertRaises(Exception):
            crypto.decrypt(bytes(blob), MASTER)

    def test_truncated(self):
        with self.assertRaises(ValueError):
            crypto.decrypt(b"court", MASTER)

    def test_nonce_and_salt_change(self):
        self.assertNotEqual(crypto.encrypt(b"x", MASTER)[:28], crypto.encrypt(b"x", MASTER)[:28])


class VaultTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "sub" / "vault.enc"

    def tearDown(self):
        self.tmp.cleanup()

    def test_missing_vault_is_empty(self):
        self.assertEqual(vault.load_vault(MASTER, self.path), {"entries": []})
        self.assertFalse(vault.vault_exists(self.path))

    def test_save_and_load(self):
        data = {"entries": [{"id": 1, "label": "Café", "password": "p", "style": "apple",
                             "created_at": "2026-11-12T10:00:00"}]}
        vault.save_vault(data, MASTER, self.path)
        self.assertEqual(vault.load_vault(MASTER, self.path), data)
        self.assertEqual(vault.next_id(data), 2)

    def test_wrong_master_message(self):
        vault.save_vault({"entries": []}, MASTER, self.path)
        with self.assertRaisesRegex(ValueError, "Mot de passe maître incorrect"):
            vault.load_vault("mauvais", self.path)

    def test_atomic_write_leaves_no_temp_file(self):
        vault.save_vault({"entries": []}, MASTER, self.path)
        vault.save_vault({"entries": []}, MASTER, self.path)
        self.assertEqual([p.name for p in self.path.parent.iterdir()], ["vault.enc"])

    @unittest.skipIf(os.name == "nt", "permissions POSIX")
    def test_permissions(self):
        vault.save_vault({"entries": []}, MASTER, self.path)
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.path.parent.stat().st_mode), 0o700)

    def test_default_path_is_module_global(self):
        original = vault.VAULT_PATH
        try:
            vault.VAULT_PATH = self.path
            vault.save_vault({"entries": []}, MASTER)
            self.assertTrue(self.path.exists())
        finally:
            vault.VAULT_PATH = original


class GeneratorTest(unittest.TestCase):
    def test_apple_format(self):
        import re
        for _ in range(50):
            pwd = generate_apple()
            self.assertRegex(pwd, r"^[a-z]{5}-[a-z0-9]{6}-[a-zA-Z]{5}$")
            self.assertEqual(len(re.findall(r"\d", pwd)), 1)

    def test_google(self):
        for _ in range(50):
            pwd = generate_google(24)
            self.assertEqual(len(pwd), 24)
            self.assertRegex(pwd, r"[A-Z]")
            self.assertRegex(pwd, r"[a-z]")
            self.assertRegex(pwd, r"\d")
            self.assertRegex(pwd, r"[!@#$%^&*]")

    def test_secret_specs(self):
        self.assertRegex(generate_secret("hex"), r"^[0-9a-f]{64}$")
        self.assertRegex(generate_secret("hex:16"), r"^[0-9a-f]{32}$")
        self.assertRegex(generate_secret("base64:32"), r"^[A-Za-z0-9_-]{43}$")
        self.assertRegex(generate_secret("uuid"), r"^[0-9a-f-]{36}$")
        self.assertEqual(len(generate_secret("google:40")), 40)

    def test_secret_invalid_specs(self):
        for spec in ("foo", "hex:abc", "hex:2", "uuid:4", "google:5"):
            with self.assertRaises(ValueError, msg=spec):
                generate_secret(spec)


if __name__ == "__main__":
    unittest.main()

