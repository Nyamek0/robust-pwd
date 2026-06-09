#!/usr/bin/env python3
"""Générateur de mots de passe robuste avec coffre chiffré AES-256-GCM."""

import argparse
import getpass
import json
import os
import secrets
import string
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

VAULT_PATH = Path.home() / ".robust-pwd" / "vault.enc"

VOWELS = "aeiou"
CONSONANTS = "bcdfghjklmnpqrstvwxyz"
SYMBOLS = "!@#$%^&*"


# ---------------------------------------------------------------------------
# Chiffrement
# ---------------------------------------------------------------------------

def _derive_key(master: str, salt: bytes) -> bytes:
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=600_000,
    )
    return kdf.derive(master.encode())


def _encrypt(data: bytes, master: str) -> bytes:
    salt = os.urandom(16)
    nonce = os.urandom(12)
    key = _derive_key(master, salt)
    ciphertext = AESGCM(key).encrypt(nonce, data, None)
    return salt + nonce + ciphertext


def _decrypt(blob: bytes, master: str) -> bytes:
    salt, nonce, ciphertext = blob[:16], blob[16:28], blob[28:]
    key = _derive_key(master, salt)
    return AESGCM(key).decrypt(nonce, ciphertext, None)


# ---------------------------------------------------------------------------
# Coffre
# ---------------------------------------------------------------------------

def _load_vault(master: str) -> dict:
    if not VAULT_PATH.exists():
        return {"entries": []}
    try:
        return json.loads(_decrypt(VAULT_PATH.read_bytes(), master))
    except (InvalidTag, Exception):
        raise ValueError("Mot de passe maître incorrect ou fichier corrompu.")


def _save_vault(vault: dict, master: str) -> None:
    VAULT_PATH.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    VAULT_PATH.write_bytes(_encrypt(json.dumps(vault, ensure_ascii=False).encode(), master))
    VAULT_PATH.chmod(0o600)


def _next_id(vault: dict) -> int:
    return max((e["id"] for e in vault["entries"]), default=0) + 1


# ---------------------------------------------------------------------------
# Génération
# ---------------------------------------------------------------------------

def _apple_group(length: int) -> str:
    chars = []
    for i in range(length):
        pool = CONSONANTS if i % 2 == 0 else VOWELS
        chars.append(secrets.choice(pool))
    return "".join(chars)


def generate_apple() -> str:
    g1 = _apple_group(5)
    g2 = list(_apple_group(5))
    g2.insert(secrets.randbelow(6), str(secrets.randbelow(10)))
    g3 = list(_apple_group(5))
    g3[secrets.randbelow(5)] = g3[secrets.randbelow(5)].upper()
    return f"{g1}-{''.join(g2)}-{''.join(g3)}"


def generate_google(length: int = 18) -> str:
    alphabet = string.ascii_letters + string.digits + SYMBOLS
    pwd = [
        secrets.choice(string.ascii_uppercase),
        secrets.choice(string.ascii_lowercase),
        secrets.choice(string.digits),
        secrets.choice(SYMBOLS),
    ]
    pwd += [secrets.choice(alphabet) for _ in range(length - 4)]
    secrets.SystemRandom().shuffle(pwd)
    return "".join(pwd)


# ---------------------------------------------------------------------------
# Presse-papier
# ---------------------------------------------------------------------------

def _copy(text: str) -> bool:
    try:
        if sys.platform == "darwin":
            cmd = ["pbcopy"]
        elif sys.platform == "win32":
            cmd = ["clip"]
        else:
            cmd = ["xclip", "-selection", "clipboard"]
        subprocess.run(cmd, input=text.encode(), check=True, capture_output=True)
        return True
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Premier lancement
# ---------------------------------------------------------------------------

def setup_master_password() -> None:
    print("\nBienvenue dans robust-pwd !")
    print("Aucun coffre trouvé. Créez votre mot de passe maître.\n")
    while True:
        pwd1 = getpass.getpass("Créez votre mot de passe maître : ")
        if not pwd1:
            print("  → Le mot de passe ne peut pas être vide.\n")
            continue
        pwd2 = getpass.getpass("Confirmez votre mot de passe maître : ")
        if pwd1 == pwd2:
            _save_vault({"entries": []}, pwd1)
            print("\n✓ Coffre initialisé avec succès.\n")
            return
        print("  → Les mots de passe ne correspondent pas. Réessayez.\n")


def _ensure_vault() -> None:
    if not VAULT_PATH.exists():
        setup_master_password()


# ---------------------------------------------------------------------------
# Affichage de la liste (partagé entre list/show/delete)
# ---------------------------------------------------------------------------

def _print_list(entries: list) -> None:
    if not entries:
        print("\n  Le coffre est vide.")
        return
    print(f"\n  {'ID':<5} {'Mot clé':<25} {'Style':<8} {'Date'}")
    print("  " + "─" * 54)
    for e in entries:
        print(f"  {e['id']:<5} {e['label']:<25} {e['style']:<8} {e['created_at']}")


# ---------------------------------------------------------------------------
# Commandes
# ---------------------------------------------------------------------------

def cmd_generate() -> None:
    print("\nStyle de mot de passe :")
    print("  1. Apple  (prononçable)    ex: xovuk-8Nevqe-hidwuf")
    print("  2. Google (aléatoire fort)  ex: Kj#9mLpQ2$vXn8!wR")
    print("  3. Les deux")
    choice = input("Choix [1/2/3] : ").strip()

    candidates: list[tuple[str, str]] = []
    if choice in ("1", "3"):
        pwd = generate_apple()
        print(f"\n  [Apple]  {pwd}")
        candidates.append(("apple", pwd))
    if choice in ("2", "3"):
        pwd = generate_google()
        print(f"\n  [Google] {pwd}")
        candidates.append(("google", pwd))
    if not candidates:
        print("  → Choix invalide.")
        return

    selected_style, selected_pwd = candidates[0]
    if len(candidates) == 2:
        print("\nLequel utiliser ?  1 = Apple  2 = Google")
        idx = input("Choix [1/2] : ").strip()
        if idx == "2":
            selected_style, selected_pwd = candidates[1]

    if _copy(selected_pwd):
        print("\nCopié dans le presse-papier.")

    while True:
        keyword = input("\nMot clé associé (ex: GitHub, Netflix) : ").strip()
        if keyword:
            break
        print("  → Le mot clé est obligatoire.")

    master = getpass.getpass("Mot de passe maître du coffre : ")
    try:
        vault = _load_vault(master)
    except ValueError as exc:
        print(f"\n  Erreur : {exc}")
        return

    entry = {
        "id": _next_id(vault),
        "label": keyword,
        "password": selected_pwd,
        "style": selected_style,
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }
    vault["entries"].append(entry)
    _save_vault(vault, master)
    print(f"\n✓ Enregistré → ID {entry['id']}  |  mot clé : « {keyword} »")


def cmd_list() -> None:
    master = getpass.getpass("\nMot de passe maître du coffre : ")
    try:
        vault = _load_vault(master)
    except ValueError as exc:
        print(f"\n  Erreur : {exc}")
        return
    _print_list(vault["entries"])


def cmd_show() -> None:
    master = getpass.getpass("\nMot de passe maître du coffre : ")
    try:
        vault = _load_vault(master)
    except ValueError as exc:
        print(f"\n  Erreur : {exc}")
        return

    _print_list(vault["entries"])
    if not vault["entries"]:
        return

    try:
        entry_id = int(input("\nID à afficher : ").strip())
    except ValueError:
        print("  → ID invalide.")
        return

    entry = next((e for e in vault["entries"] if e["id"] == entry_id), None)
    if not entry:
        print(f"\n  Aucune entrée avec l'ID {entry_id}.")
        return

    print(f"\n  Mot clé     : {entry['label']}")
    print(f"  Style       : {entry['style']}")
    print(f"  Date        : {entry['created_at']}")
    print(f"  Mot de passe: {entry['password']}")
    if _copy(entry["password"]):
        print("\n  Copié dans le presse-papier.")


def cmd_delete() -> None:
    master = getpass.getpass("\nMot de passe maître du coffre : ")
    try:
        vault = _load_vault(master)
    except ValueError as exc:
        print(f"\n  Erreur : {exc}")
        return

    _print_list(vault["entries"])
    if not vault["entries"]:
        return

    try:
        entry_id = int(input("\nID à supprimer : ").strip())
    except ValueError:
        print("  → ID invalide.")
        return

    entry = next((e for e in vault["entries"] if e["id"] == entry_id), None)
    if not entry:
        print(f"\n  Aucune entrée avec l'ID {entry_id}.")
        return

    confirm = input(f"  Supprimer « {entry['label']} » ? (o/n) : ").strip().lower()
    if confirm != "o":
        print("  → Annulé.")
        return

    vault["entries"] = [e for e in vault["entries"] if e["id"] != entry_id]
    _save_vault(vault, master)
    print(f"\n✓ Entrée {entry_id} supprimée.")


# ---------------------------------------------------------------------------
# Menu interactif
# ---------------------------------------------------------------------------

def _show_menu() -> str:
    print("\n" + "━" * 42)
    print("  robust-pwd — Gestionnaire de mots de passe")
    print("━" * 42)
    print("  1. Générer un mot de passe")
    print("  2. Lister les mots de passe")
    print("  3. Afficher un mot de passe")
    print("  4. Supprimer un mot de passe")
    print("  0. Quitter")
    print("━" * 42)
    return input("Votre choix : ").strip()


def run_interactive() -> None:
    _ensure_vault()
    while True:
        choice = _show_menu()
        if choice == "1":
            cmd_generate()
        elif choice == "2":
            cmd_list()
        elif choice == "3":
            cmd_show()
        elif choice == "4":
            cmd_delete()
        elif choice == "0":
            print("\nAu revoir !\n")
            break
        else:
            print("  → Choix invalide, tapez 0-4.")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Générateur de mots de passe robuste — AES-256-GCM",
    )
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("generate", help="Générer et sauvegarder un nouveau mot de passe")
    sub.add_parser("list", help="Lister les mots de passe enregistrés")
    sub.add_parser("show", help="Afficher le mot de passe d'une entrée")
    sub.add_parser("delete", help="Supprimer une entrée")

    args = parser.parse_args()

    if args.command is None:
        run_interactive()
        return

    _ensure_vault()
    dispatch = {
        "generate": cmd_generate,
        "list": cmd_list,
        "show": cmd_show,
        "delete": cmd_delete,
    }
    dispatch[args.command]()


if __name__ == "__main__":
    main()
