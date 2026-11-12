"""Interface en ligne de commande : coffre de mots de passe et menu interactif."""

import argparse
import getpass
from datetime import datetime

from . import clipboard, vault
from .cli_secrets import dispatch_secrets, register_secrets_subparser, run_secrets_interactive
from .generator import generate_apple, generate_google


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
            vault.save_vault({"entries": []}, pwd1)
            print("\n✓ Coffre initialisé avec succès.\n")
            return
        print("  → Les mots de passe ne correspondent pas. Réessayez.\n")


def ensure_vault() -> None:
    if not vault.vault_exists():
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


def _unlock(prompt: str = "\nMot de passe maître du coffre : "):
    master = getpass.getpass(prompt)
    try:
        return master, vault.load_vault(master)
    except ValueError as exc:
        print(f"\n  Erreur : {exc}")
        return None, None


# ---------------------------------------------------------------------------
# Commandes
# ---------------------------------------------------------------------------

def cmd_generate() -> None:
    print("\nStyle de mot de passe :")
    print("  1. Apple  (prononçable)    ex: xovuk-8Nevqe-hidwuf")
    print("  2. Google (aléatoire fort)  ex: Kj#9mLpQ2$vXn8!wR")
    print("  3. Les deux")
    choice = input("Choix [1/2/3] : ").strip()

    candidates = []
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

    if clipboard.copy(selected_pwd):
        print("\nCopié dans le presse-papier.")

    while True:
        keyword = input("\nMot clé associé (ex: GitHub, Netflix) : ").strip()
        if keyword:
            break
        print("  → Le mot clé est obligatoire.")

    master, data = _unlock("Mot de passe maître du coffre : ")
    if data is None:
        return

    entry = {
        "id": vault.next_id(data),
        "label": keyword,
        "password": selected_pwd,
        "style": selected_style,
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }
    data["entries"].append(entry)
    vault.save_vault(data, master)
    print(f"\n✓ Enregistré → ID {entry['id']}  |  mot clé : « {keyword} »")


def cmd_list() -> None:
    _, data = _unlock()
    if data is None:
        return
    _print_list(data["entries"])


def _pick_entry(data: dict, prompt: str):
    _print_list(data["entries"])
    if not data["entries"]:
        return None
    try:
        entry_id = int(input(prompt).strip())
    except ValueError:
        print("  → ID invalide.")
        return None
    entry = next((e for e in data["entries"] if e["id"] == entry_id), None)
    if not entry:
        print(f"\n  Aucune entrée avec l'ID {entry_id}.")
    return entry


def cmd_show() -> None:
    _, data = _unlock()
    if data is None:
        return
    entry = _pick_entry(data, "\nID à afficher : ")
    if not entry:
        return

    print(f"\n  Mot clé     : {entry['label']}")
    print(f"  Style       : {entry['style']}")
    print(f"  Date        : {entry['created_at']}")
    print(f"  Mot de passe: {entry['password']}")
    if clipboard.copy(entry["password"]):
        print("\n  Copié dans le presse-papier.")


def cmd_delete() -> None:
    master, data = _unlock()
    if data is None:
        return
    entry = _pick_entry(data, "\nID à supprimer : ")
    if not entry:
        return

    confirm = input(f"  Supprimer « {entry['label']} » ? (o/n) : ").strip().lower()
    if confirm != "o":
        print("  → Annulé.")
        return

    data["entries"] = [e for e in data["entries"] if e["id"] != entry["id"]]
    vault.save_vault(data, master)
    print(f"\n✓ Entrée {entry['id']} supprimée.")


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
    print("  5. Secrets d'application (.env / CI)")
    print("  0. Quitter")
    print("━" * 42)
    return input("Votre choix : ").strip()


def run_interactive() -> None:
    ensure_vault()
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
        elif choice == "5":
            run_secrets_interactive()
        elif choice == "0":
            print("\nAu revoir !\n")
            break
        else:
            print("  → Choix invalide, tapez 0-5.")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="robust-pwd",
        description="Générateur de mots de passe robuste — AES-256-GCM",
    )
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("generate", help="Générer et sauvegarder un nouveau mot de passe")
    sub.add_parser("list", help="Lister les mots de passe enregistrés")
    sub.add_parser("show", help="Afficher le mot de passe d'une entrée")
    sub.add_parser("delete", help="Supprimer une entrée")
    register_secrets_subparser(sub)
    return parser


def main(argv=None) -> None:
    import sys

    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass

    # Pour « robust-pwd secrets run [projet] [env] -- <commande...> »,
    # on isole les arguments après « -- » avant argparse afin que les options
    # de la commande enfant (ex. -c, --version) ne soient pas consommées par argparse.
    raw_argv = list(sys.argv[1:] if argv is None else argv)
    remainder = None
    if len(raw_argv) >= 2 and raw_argv[0] == "secrets" and "run" in raw_argv[1:] and "--" in raw_argv:
        sep = raw_argv.index("--")
        remainder = raw_argv[sep + 1:]
        raw_argv = raw_argv[:sep]

    parser = build_parser()
    args = parser.parse_args(raw_argv)
    if remainder is not None:
        args.cmd = remainder

    if args.command is None:
        run_interactive()
        return

    if args.command == "secrets":
        code = dispatch_secrets(args, parser)
        if code:
            sys.exit(code)
        return

    ensure_vault()
    dispatch = {
        "generate": cmd_generate,
        "list": cmd_list,
        "show": cmd_show,
        "delete": cmd_delete,
    }
    dispatch[args.command]()

