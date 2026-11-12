"""Sous-commandes CLI ``robust-pwd secrets`` et menu interactif associé."""

import argparse
import getpass
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import clipboard, crypto, dotenv
from .generator import generate_secret
from .project_file import is_git_ignored, resolve_project_and_env, write_project_file
from .providers import ProviderError, create_provider
from .secrets_vault import (
     SecretsVaultError,
    add_environment,
    add_project,
    create_secrets_vault,
    default_secrets_path,
    find_credential,
    find_environment,
    find_project,
    get_variable,
    import_variables,
    link_remote,
    load_secrets_vault,
    normalize_host,
    remove_credential,
    remove_environment,
    remove_project,
    save_credential,
    save_secrets_vault,
    secrets_vault_exists,
    set_remote_scope,
    set_variable,
     unset_variable,
    validate_master,
    validate_provider,
)
from .sync import build_sync_plan


def _read_master(master_stdin: bool, prompt: str = "Mot de passe maître des secrets : ") -> str:
    if master_stdin:
        line = sys.stdin.readline()
        return line.rstrip("\r\n")
    return getpass.getpass(prompt)


def _unlock(master_stdin: bool, path: Optional[Path] = None) -> Tuple[str, Dict[str, Any]]:
    master = _read_master(master_stdin)
    vault = load_secrets_vault(master, path)
    return master, vault


def _prompt_new_master(master_stdin: bool) -> str:
    if master_stdin:
        pwd = sys.stdin.readline().rstrip("\r\n")
        return validate_master(pwd)
    while True:
        pwd1 = getpass.getpass("Nouveau mot de passe maître des secrets (8 caractères min.) : ")
        try:
            validate_master(pwd1)
        except SecretsVaultError as exc:
            print(f"  → {exc}")
            continue
        pwd2 = getpass.getpass("Confirmez le mot de passe maître : ")
        if pwd1 == pwd2:
            return pwd1
        print("  → Les mots de passe ne correspondent pas. Réessayez.")


# ---------------------------------------------------------------------------
# Gestionnaires de sous-commandes
# ---------------------------------------------------------------------------

def cmd_init(args: argparse.Namespace) -> int:
    path = default_secrets_path()
    if secrets_vault_exists(path):
        print(f"  Erreur : Un coffre de secrets existe déjà ({path}).", file=sys.stderr)
        return 1
    master = _prompt_new_master(bool(getattr(args, "master_stdin", False)))
    create_secrets_vault(master, path)
    print(f"✓ Coffre de secrets initialisé ({path}).")
    return 0


def cmd_passwd(args: argparse.Namespace) -> int:
    if getattr(args, "master_stdin", False):
        old_master = sys.stdin.readline().rstrip("\r\n")
        new_master = sys.stdin.readline().rstrip("\r\n")
        vault = load_secrets_vault(old_master)
        validate_master(new_master)
        save_secrets_vault(vault, new_master)
        print("✓ Mot de passe maître des secrets modifié.")
        return 0

    old_master = getpass.getpass("Mot de passe maître actuel : ")
    vault = load_secrets_vault(old_master)
    new_master = _prompt_new_master(False)
    save_secrets_vault(vault, new_master)
    print("✓ Mot de passe maître des secrets modifié.")
    return 0


def cmd_project_add(args: argparse.Namespace) -> int:
    master, vault = _unlock(args.master_stdin)
    envs = [e.strip() for e in args.env.split(",") if e.strip()] if args.env else None
    proj = add_project(vault, args.name, description=args.desc or "", environments=envs)
    save_secrets_vault(vault, master)
    env_list = ", ".join(e["name"] for e in proj["environments"])
    print(f"✓ Projet « {proj['name']} » créé (environnements : {env_list}).")
    return 0


def cmd_project_list(args: argparse.Namespace) -> int:
    _, vault = _unlock(args.master_stdin)
    projects = vault["projects"]
    if not projects:
        print("\n  Aucun projet dans le coffre de secrets.")
        return 0
    print(f"\n  {'ID':<4} {'Projet':<22} {'Environnements':<30} {'Distant'}")
    print("  " + "─" * 74)
    for proj in projects:
        envs = ", ".join(f"{e['name']}({len(e['variables'])})" for e in proj["environments"])
        remote = (
            f"{proj['remote']['provider']}:{proj['remote']['target']}"
            if proj.get("remote")
            else "—"
        )
        print(f"  {proj['id']:<4} {proj['name']:<22} {envs:<30} {remote}")
    return 0


def cmd_project_rm(args: argparse.Namespace) -> int:
    master, vault = _unlock(args.master_stdin)
    proj = find_project(vault, args.name)
    if not args.yes:
        ans = input(f"Supprimer définitivement le projet « {proj['name']} » ? (o/n) : ").strip().lower()
        if ans != "o":
            print("  → Annulé.")
            return 0
    remove_project(vault, proj["id"])
    save_secrets_vault(vault, master)
    print(f"✓ Projet « {proj['name']} » supprimé.")
    return 0


def cmd_env_add(args: argparse.Namespace) -> int:
    master, vault = _unlock(args.master_stdin)
    env = add_environment(vault, args.project, args.env)
    save_secrets_vault(vault, master)
    print(f"✓ Environnement « {env['name']} » ajouté au projet « {args.project} ».")
    return 0


def cmd_env_rm(args: argparse.Namespace) -> int:
    master, vault = _unlock(args.master_stdin)
    if not args.yes:
        ans = input(f"Supprimer l'environnement « {args.env} » de « {args.project} » ? (o/n) : ").strip().lower()
        if ans != "o":
            print("  → Annulé.")
            return 0
    remove_environment(vault, args.project, args.env)
    save_secrets_vault(vault, master)
    print(f"✓ Environnement « {args.env} » supprimé de « {args.project} ».")
    return 0


def cmd_set(args: argparse.Namespace) -> int:
    if "=" in args.key:
        raise SecretsVaultError(
            "INVALID",
            "Ne passez jamais de valeur en argument sur la ligne de commande. "
            "Indiquez uniquement la clé, puis saisissez la valeur ou utilisez --stdin.",
        )
    if args.master_stdin and args.stdin:
        raise SecretsVaultError(
            "INVALID",
            "--master-stdin et --stdin ne peuvent pas être utilisés ensemble.",
        )

    master, vault = _unlock(args.master_stdin)
    if args.generate:
        try:
            value = generate_secret(args.generate)
        except ValueError as exc:
            raise SecretsVaultError("INVALID", str(exc))
    elif args.stdin:
        value = sys.stdin.read()
        if value.endswith("\r\n"):
            value = value[:-2]
        elif value.endswith("\n"):
            value = value[:-1]
    else:
        value = getpass.getpass(f"Valeur pour {args.key} : ")

    var_type = "file" if args.file else None
    rec = set_variable(
        vault,
        args.project,
        args.env,
        args.key,
        value,
        masked=args.masked,
        protected=args.protected,
        var_type=var_type,
    )
    save_secrets_vault(vault, master)
    print(f"✓ Variable « {rec['key']} » enregistrée dans {args.project}/{args.env}.")
    return 0


def cmd_get(args: argparse.Namespace) -> int:
    _, vault = _unlock(args.master_stdin)
    var = get_variable(vault, args.project, args.env, args.key)
    if args.copy:
        if clipboard.copy(var["value"]):
            print(f"✓ Valeur de « {var['key']} » copiée dans le presse-papier.")
            return 0
        print("  Erreur : Impossible de copier dans le presse-papier.", file=sys.stderr)
        return 1
    sys.stdout.write(var["value"])
    if not var["value"].endswith("\n"):
        sys.stdout.write("\n")
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    project_name, env_name = resolve_project_and_env(args.project, args.env)
    _, vault = _unlock(args.master_stdin)
    proj = find_project(vault, project_name)
    env = find_environment(proj, env_name)
    scope = env.get("remote_scope") or "—"
    print(f"\n  Projet : {proj['name']}  |  Environnement : {env['name']}  |  Portée distante : {scope}")
    if not env["variables"]:
        print("  Aucune variable enregistrée.")
        return 0
    print(f"\n  {'Clé':<28} {'Long.':<7} {'Masked':<8} {'Prot.':<7} {'Type':<9} {'Modifiée'}")
    print("  " + "─" * 76)
    for var in env["variables"]:
        print(
            f"  {var['key']:<28} {len(var['value']):<7} "
            f"{'oui' if var['masked'] else 'non':<8} "
            f"{'oui' if var['protected'] else 'non':<7} "
            f"{var['type']:<9} {var['updated_at']}"
        )
    return 0


def cmd_unset(args: argparse.Namespace) -> int:
    master, vault = _unlock(args.master_stdin)
    unset_variable(vault, args.project, args.env, args.key)
    save_secrets_vault(vault, master)
    print(f"✓ Variable « {args.key} » supprimée de {args.project}/{args.env}.")
    return 0


def cmd_import(args: argparse.Namespace) -> int:
    file_path = Path(args.file)
    if not file_path.is_file():
        raise SecretsVaultError("NOT_FOUND", f"Fichier introuvable : {file_path}")
    text = file_path.read_text(encoding="utf-8")
    parsed = dotenv.parse(text)
    master, vault = _unlock(args.master_stdin)
    added, updated, skipped = import_variables(
        vault,
        args.project,
        args.env,
        parsed["variables"],  # type: ignore[arg-type]
        overwrite=not args.no_overwrite,
    )
    save_secrets_vault(vault, master)
    print(
        f"✓ Import terminé ({args.project}/{args.env}) : "
        f"{added} ajoutée(s), {updated} modifiée(s), {skipped} ignorée(s)."
    )
    if parsed["duplicates"]:
        dups = ", ".join(parsed["duplicates"])  # type: ignore[arg-type]
        print(f"  Note : clés dupliquées dans le fichier (dernière retenue) : {dups}")
    if parsed["invalid_lines"]:
        lines = ", ".join(str(n) for n in parsed["invalid_lines"])  # type: ignore[union-attr]
        print(f"  Attention : lignes invalides ignorées : {lines}")
    return 0


def cmd_export(args: argparse.Namespace) -> int:
    project_name, env_name = resolve_project_and_env(args.project, args.env)
    _, vault = _unlock(args.master_stdin)
    proj = find_project(vault, project_name)
    env = find_environment(proj, env_name)
    pairs = [{"key": v["key"], "value": v["value"]} for v in env["variables"]]
    rendered = dotenv.serialize(pairs, args.format)

    if args.output:
        out_path = Path(args.output)
        crypto.write_atomic(out_path, rendered.encode("utf-8"))
        print(f"✓ Exporté dans {out_path} (permissions 600).")
        if is_git_ignored(out_path) is False:
            print(
                f"  ⚠ Attention : « {out_path} » n'est pas ignoré par Git ! "
                "Ajoutez-le à votre .gitignore avant tout commit.",
                file=sys.stderr,
            )
        return 0

    sys.stdout.write(rendered)
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    cmd = list(args.cmd or [])
    if cmd and cmd[0] == "--":
        cmd = cmd[1:]
    if not cmd:
        raise SecretsVaultError("INVALID", "Aucune commande à exécuter après « -- ».")

    project_name, env_name = resolve_project_and_env(args.project, args.env)
    _, vault = _unlock(args.master_stdin)
    proj = find_project(vault, project_name)
    env = find_environment(proj, env_name)

    child_env = os.environ.copy()
    for var in env["variables"]:
        child_env[var["key"]] = var["value"]

    try:
        completed = subprocess.run(cmd, env=child_env)
        return completed.returncode
    except FileNotFoundError:
        print(f"  Erreur : Commande introuvable : « {cmd[0]} ».", file=sys.stderr)
        return 127


def cmd_link_dir(args: argparse.Namespace) -> int:
    target = write_project_file(args.project, args.env or "local")
    print(f"✓ Dossier relié à {args.project}/{args.env or 'local'} ({target}).")
    return 0


def cmd_remote_login(args: argparse.Namespace) -> int:
    if args.master_stdin and args.token_stdin:
        raise SecretsVaultError(
            "INVALID",
            "--master-stdin et --token-stdin ne peuvent pas être utilisés ensemble.",
        )
    provider_name = validate_provider(args.provider)
    host = normalize_host(args.host, provider_name)
    master, vault = _unlock(args.master_stdin)
    if args.token_stdin:
        token = sys.stdin.readline().strip()
    else:
        token = getpass.getpass(f"Jeton {provider_name} ({host}) : ").strip()
    if not token:
        raise SecretsVaultError("INVALID", "Le jeton ne peut pas être vide.")

    client = create_provider(provider_name, host, token)
    identity = client.verify_token()
    save_credential(vault, provider_name, token, host)
    save_secrets_vault(vault, master)
    print(f"✓ Connecté à {provider_name} ({host}) en tant que « {identity} ».")
    return 0


def cmd_remote_logout(args: argparse.Namespace) -> int:
    provider_name = validate_provider(args.provider)
    host = normalize_host(args.host, provider_name)
    master, vault = _unlock(args.master_stdin)
    removed = remove_credential(vault, provider_name, host)
    save_secrets_vault(vault, master)
    if removed:
        print(f"✓ Jeton {provider_name} ({host}) supprimé du coffre.")
    else:
        print(f"  Aucun jeton enregistré pour {provider_name} ({host}).")
    return 0


def cmd_remote_link(args: argparse.Namespace) -> int:
    master, vault = _unlock(args.master_stdin)
    remote = link_remote(vault, args.project, args.provider, args.target, args.host)
    save_secrets_vault(vault, master)
    print(
        f"✓ Projet « {args.project} » relié à {remote['provider']} "
        f"({remote['host']} → {remote['target']})."
    )
    return 0


def cmd_remote_scope(args: argparse.Namespace) -> int:
    master, vault = _unlock(args.master_stdin)
    scope = set_remote_scope(vault, args.project, args.env, args.scope)
    save_secrets_vault(vault, master)
    label = scope if scope else "désactivée"
    print(f"✓ Portée distante de {args.project}/{args.env} : {label}.")
    return 0


def _iter_synced_envs(proj: Dict[str, Any], env_filter: Optional[str]) -> List[Dict[str, Any]]:
    if env_filter:
        env = find_environment(proj, env_filter)
        if not env.get("remote_scope"):
            raise SecretsVaultError(
                "INVALID",
                f"L'environnement « {env_filter} » n'a pas de portée distante configurée "
                f"(utilisez « robust-pwd secrets remote scope {proj['name']} {env_filter} <portée> »).",
            )
        return [env]
    envs = [e for e in proj["environments"] if e.get("remote_scope")]
    if not envs:
        raise SecretsVaultError(
            "INVALID",
            f"Aucun environnement du projet « {proj['name']} » n'a de portée distante configurée.",
        )
    return envs


def _require_remote_client(vault: Dict[str, Any], proj: Dict[str, Any]):
    remote = proj.get("remote")
    if not remote:
        raise SecretsVaultError(
            "INVALID",
            f"Le projet « {proj['name']} » n'est relié à aucun fournisseur distant.",
        )
    token = find_credential(vault, remote["provider"], remote["host"])
    if not token:
        raise SecretsVaultError(
            "NOT_FOUND",
            f"Aucun jeton enregistré pour {remote['provider']} ({remote['host']}). "
            f"Lancez « robust-pwd secrets remote login {remote['provider']} ».",
        )
    return remote, create_provider(remote["provider"], remote["host"], token)


def _print_plan(plan: Dict[str, Any]) -> None:
    print(
        f"\n  Plan [{plan['provider']}] {plan['target']} — "
        f"env « {plan['environment']} » (portée « {plan['scope']} »)"
    )
    print("  " + "─" * 64)
    labels = {
        "create": "+ créer",
        "update": "~ modifier",
        "overwrite": "~ écraser (valeur distante inconnue)",
        "delete": "- supprimer",
        "keep": "  conserver (distant seul)",
        "unchanged": "= identique",
    }
    for item in plan["items"]:
        print(f"  {labels[item['action']]:<36} {item['key']}")
    if not plan["items"]:
        print("  (aucune variable)")
    if plan["errors"]:
        print("\n  Erreurs de validation :")
        for err in plan["errors"]:
            print(f"    ✗ {err}")


def cmd_remote_diff(args: argparse.Namespace) -> int:
    _, vault = _unlock(args.master_stdin)
    proj = find_project(vault, args.project)
    remote, client = _require_remote_client(vault, proj)
    envs = _iter_synced_envs(proj, args.env)
    has_errors = False
    for env in envs:
        remote_vars = client.list_remote(remote["target"], env["remote_scope"])
        plan = build_sync_plan(
            provider=remote["provider"],
            target=remote["target"],
            environment=env["name"],
            scope=env["remote_scope"],
            local_vars=env["variables"],
            remote_vars=remote_vars,
            prune=args.prune,
        )
        _print_plan(plan)
        if plan["errors"]:
            has_errors = True
    return 1 if has_errors else 0


def cmd_remote_push(args: argparse.Namespace) -> int:
    _, vault = _unlock(args.master_stdin)
    proj = find_project(vault, args.project)
    remote, client = _require_remote_client(vault, proj)
    envs = _iter_synced_envs(proj, args.env)

    plans = []
    for env in envs:
        remote_vars = client.list_remote(remote["target"], env["remote_scope"])
        plan = build_sync_plan(
            provider=remote["provider"],
            target=remote["target"],
            environment=env["name"],
            scope=env["remote_scope"],
            local_vars=env["variables"],
            remote_vars=remote_vars,
            prune=args.prune,
        )
        _print_plan(plan)
        if plan["errors"]:
            print("\n  Envoi bloqué par des erreurs de validation.", file=sys.stderr)
            return 1
        plans.append((env, plan))

    deletions = sum(p["counts"]["delete"] for _, p in plans)
    changes = sum(
        p["counts"]["create"] + p["counts"]["update"] + p["counts"]["overwrite"] + p["counts"]["delete"]
        for _, p in plans
    )
    if changes == 0:
        print("\n  Rien à envoyer.")
        return 0

    if not args.yes or deletions > 0:
        warn = f" dont {deletions} suppression(s)" if deletions else ""
        ans = input(f"\nAppliquer ces {changes} modification(s){warn} ? (o/n) : ").strip().lower()
        if ans != "o":
            print("  → Annulé.")
            return 0

    for env, plan in plans:
        summary = client.apply_plan(
            remote["target"],
            env["remote_scope"],
            env["variables"],
            plan["items"],
        )
        print(
            f"✓ {env['name']} : {summary['created']} créée(s), "
            f"{summary['updated']} mise(s) à jour, {summary['deleted']} supprimée(s)."
        )
    return 0


def cmd_remote_pull(args: argparse.Namespace) -> int:
    master, vault = _unlock(args.master_stdin)
    proj = find_project(vault, args.project)
    remote, client = _require_remote_client(vault, proj)
    if not client.can_read_values:
        raise SecretsVaultError(
            "INVALID",
            f"Le fournisseur « {remote['provider']} » ne permet pas de relire la valeur des secrets.",
        )
    envs = _iter_synced_envs(proj, args.env)
    for env in envs:
        remote_vars = client.list_remote(remote["target"], env["remote_scope"])
        added = updated = skipped = 0
        local_by_key = {v["key"]: v for v in env["variables"]}
        for rvar in remote_vars:
            if rvar["key"] in local_by_key:
                if args.no_overwrite:
                    skipped += 1
                    continue
                updated += 1
            else:
                added += 1
            set_variable(
                vault,
                proj["id"],
                env["name"],
                rvar["key"],
                rvar["value"],
                masked=rvar.get("masked", False),
                protected=rvar.get("protected", False),
                raw=rvar.get("raw", True),
                var_type=rvar.get("type", "env_var"),
            )
        print(
            f"✓ {env['name']} : {added} récupérée(s), {updated} mise(s) à jour, {skipped} ignorée(s)."
        )
    save_secrets_vault(vault, master)
    return 0


# ---------------------------------------------------------------------------
# Construction du sous-parseur argparse
# ---------------------------------------------------------------------------

def register_secrets_subparser(subparsers) -> argparse.ArgumentParser:
    secrets_parser = subparsers.add_parser(
        "secrets",
        help="Gérer le coffre de secrets applicatifs (.env, GitLab, GitHub)",
    )
    secrets_parser.add_argument(
        "--master-stdin",
        action="store_true",
        help="Lire le mot de passe maître sur la première ligne de l'entrée standard",
    )
    sec_sub = secrets_parser.add_subparsers(dest="secrets_command")

    sec_sub.add_parser("init", help="Initialiser le coffre de secrets (secrets.enc)")
    sec_sub.add_parser("passwd", help="Changer le mot de passe maître du coffre de secrets")

    # project
    proj_p = sec_sub.add_parser("project", help="Gérer les projets")
    proj_sub = proj_p.add_subparsers(dest="project_command")
    p_add = proj_sub.add_parser("add", help="Créer un projet")
    p_add.add_argument("name", help="Nom du projet")
    p_add.add_argument("--desc", default="", help="Description")
    p_add.add_argument("--env", default="", help="Environnements séparés par des virgules")
    proj_sub.add_parser("list", help="Lister les projets")
    p_rm = proj_sub.add_parser("rm", help="Supprimer un projet")
    p_rm.add_argument("name", help="Nom du projet")
    p_rm.add_argument("--yes", "-y", action="store_true", help="Ne pas demander confirmation")

    # env
    env_p = sec_sub.add_parser("env", help="Gérer les environnements d'un projet")
    env_sub = env_p.add_subparsers(dest="env_command")
    e_add = env_sub.add_parser("add", help="Ajouter un environnement")
    e_add.add_argument("project", help="Nom du projet")
    e_add.add_argument("env", help="Nom de l'environnement")
    e_rm = env_sub.add_parser("rm", help="Supprimer un environnement")
    e_rm.add_argument("project", help="Nom du projet")
    e_rm.add_argument("env", help="Nom de l'environnement")
    e_rm.add_argument("--yes", "-y", action="store_true", help="Ne pas demander confirmation")

    # set
    s_set = sec_sub.add_parser("set", help="Définir ou modifier une variable")
    s_set.add_argument("project", help="Nom du projet")
    s_set.add_argument("env", help="Nom de l'environnement")
    s_set.add_argument("key", help="Clé de la variable")
    s_set.add_argument("--stdin", action="store_true", help="Lire la valeur sur l'entrée standard")
    s_set.add_argument("--generate", metavar="SPEC", help="Générer une valeur (hex:32, base64:32, uuid, google:32)")
    mask_grp = s_set.add_mutually_exclusive_group()
    mask_grp.add_argument("--masked", dest="masked", action="store_true", default=None)
    mask_grp.add_argument("--no-masked", dest="masked", action="store_false")
    prot_grp = s_set.add_mutually_exclusive_group()
    prot_grp.add_argument("--protected", dest="protected", action="store_true", default=None)
    prot_grp.add_argument("--no-protected", dest="protected", action="store_false")
    s_set.add_argument("--file", action="store_true", help="Marquer la variable comme fichier (GitLab)")

    # get
    s_get = sec_sub.add_parser("get", help="Afficher ou copier une variable")
    s_get.add_argument("project", help="Nom du projet")
    s_get.add_argument("env", help="Nom de l'environnement")
    s_get.add_argument("key", help="Clé de la variable")
    s_get.add_argument("--copy", "-c", action="store_true", help="Copier dans le presse-papier")

    # list
    s_list = sec_sub.add_parser("list", help="Lister les variables (sans les valeurs)")
    s_list.add_argument("project", nargs="?", help="Nom du projet (ou .robust-pwd.json)")
    s_list.add_argument("env", nargs="?", help="Nom de l'environnement")

    # unset
    s_unset = sec_sub.add_parser("unset", help="Supprimer une variable")
    s_unset.add_argument("project", help="Nom du projet")
    s_unset.add_argument("env", help="Nom de l'environnement")
    s_unset.add_argument("key", help="Clé de la variable")

    # import
    s_imp = sec_sub.add_parser("import", help="Importer un fichier .env")
    s_imp.add_argument("project", help="Nom du projet")
    s_imp.add_argument("env", help="Nom de l'environnement")
    s_imp.add_argument("file", help="Chemin du fichier .env")
    s_imp.add_argument("--no-overwrite", action="store_true", help="Ne pas écraser les clés existantes")

    # export
    s_exp = sec_sub.add_parser("export", help="Exporter les variables d'un environnement")
    s_exp.add_argument("project", nargs="?", help="Nom du projet (ou .robust-pwd.json)")
    s_exp.add_argument("env", nargs="?", help="Nom de l'environnement")
    s_exp.add_argument("-o", "--output", help="Fichier de sortie (créé en permissions 600)")
    s_exp.add_argument("--format", choices=("dotenv", "shell", "json"), default="dotenv")

    # run
    s_run = sec_sub.add_parser("run", help="Exécuter une commande avec les variables injectées en mémoire")
    s_run.add_argument("project", nargs="?", help="Nom du projet (ou .robust-pwd.json)")
    s_run.add_argument("env", nargs="?", help="Nom de l'environnement")
    s_run.add_argument("cmd", nargs=argparse.REMAINDER, help="Commande précédée de --")

    # link-dir
    s_ldir = sec_sub.add_parser("link-dir", help="Créer .robust-pwd.json dans le dossier courant")
    s_ldir.add_argument("project", help="Nom du projet")
    s_ldir.add_argument("--env", default="local", help="Environnement par défaut (local)")

    # remote
    rem_p = sec_sub.add_parser("remote", help="Synchronisation avec GitLab CI/CD ou GitHub Actions")
    rem_sub = rem_p.add_subparsers(dest="remote_command")

    r_login = rem_sub.add_parser("login", help="Enregistrer un jeton de fournisseur dans le coffre")
    r_login.add_argument("provider", choices=("gitlab", "github"))
    r_login.add_argument("--host", default=None, help="URL HTTPS de l'instance")
    r_login.add_argument("--token-stdin", action="store_true", help="Lire le jeton sur l'entrée standard")

    r_logout = rem_sub.add_parser("logout", help="Supprimer le jeton d'un fournisseur")
    r_logout.add_argument("provider", choices=("gitlab", "github"))
    r_logout.add_argument("--host", default=None, help="URL HTTPS de l'instance")

    r_link = rem_sub.add_parser("link", help="Relier un projet local à un projet/dépôt distant")
    r_link.add_argument("project", help="Projet local")
    r_link.add_argument("provider", choices=("gitlab", "github"))
    r_link.add_argument("target", help="groupe/projet (GitLab) ou propriétaire/dépôt (GitHub)")
    r_link.add_argument("--host", default=None, help="URL HTTPS de l'instance")

    r_scope = rem_sub.add_parser("scope", help="Associer un environnement local à une portée distante")
    r_scope.add_argument("project", help="Projet local")
    r_scope.add_argument("env", help="Environnement local")
    r_scope.add_argument("scope", help="Portée distante (*, production…) ou none")

    r_diff = rem_sub.add_parser("diff", help="Afficher le plan de synchronisation")
    r_diff.add_argument("project", help="Projet local")
    r_diff.add_argument("--env", default=None, help="Environnement (tous ceux configurés par défaut)")
    r_diff.add_argument("--prune", action="store_true", help="Inclure la suppression des variables distantes")

    r_push = rem_sub.add_parser("push", help="Envoyer les variables vers le fournisseur distant")
    r_push.add_argument("project", help="Projet local")
    r_push.add_argument("--env", default=None, help="Environnement")
    r_push.add_argument("--prune", action="store_true", help="Supprimer à distance les variables absentes localement")
    r_push.add_argument("--yes", "-y", action="store_true", help="Ne pas demander confirmation (hors suppressions)")

    r_pull = rem_sub.add_parser("pull", help="Récupérer les variables depuis GitLab")
    r_pull.add_argument("project", help="Projet local")
    r_pull.add_argument("--env", default=None, help="Environnement")
    r_pull.add_argument("--no-overwrite", action="store_true", help="Ne pas écraser les variables locales")

    return secrets_parser


def dispatch_secrets(args: argparse.Namespace, parser: argparse.ArgumentParser) -> int:
    cmd = getattr(args, "secrets_command", None)
    if cmd is None:
        parser.print_help()
        return 1

    try:
        if cmd == "init":
            return cmd_init(args)
        if cmd == "passwd":
            return cmd_passwd(args)
        if cmd == "project":
            sub = getattr(args, "project_command", None)
            if sub == "add":
                return cmd_project_add(args)
            if sub == "list":
                return cmd_project_list(args)
            if sub == "rm":
                return cmd_project_rm(args)
            parser.print_help()
            return 1
        if cmd == "env":
            sub = getattr(args, "env_command", None)
            if sub == "add":
                return cmd_env_add(args)
            if sub == "rm":
                return cmd_env_rm(args)
            parser.print_help()
            return 1
        if cmd == "set":
            return cmd_set(args)
        if cmd == "get":
            return cmd_get(args)
        if cmd == "list":
            return cmd_list(args)
        if cmd == "unset":
            return cmd_unset(args)
        if cmd == "import":
            return cmd_import(args)
        if cmd == "export":
            return cmd_export(args)
        if cmd == "run":
            return cmd_run(args)
        if cmd == "link-dir":
            return cmd_link_dir(args)
        if cmd == "remote":
            sub = getattr(args, "remote_command", None)
            if sub == "login":
                return cmd_remote_login(args)
            if sub == "logout":
                return cmd_remote_logout(args)
            if sub == "link":
                return cmd_remote_link(args)
            if sub == "scope":
                return cmd_remote_scope(args)
            if sub == "diff":
                return cmd_remote_diff(args)
            if sub == "push":
                return cmd_remote_push(args)
            if sub == "pull":
                return cmd_remote_pull(args)
            parser.print_help()
            return 1
    except (SecretsVaultError, ProviderError) as exc:
        print(f"  Erreur : {exc}", file=sys.stderr)
        return 1

    parser.print_help()
    return 1


def run_secrets_interactive() -> None:
    """Sous-menu interactif des secrets applicatifs."""
    if not secrets_vault_exists():
        print("\nAucun coffre de secrets trouvé. Initialisation de secrets.enc…")
        master = _prompt_new_master(False)
        create_secrets_vault(master)
        print("✓ Coffre de secrets initialisé.")

    while True:
        print("\n" + "─" * 42)
        print("  Secrets d'application (secrets.enc)")
        print("─" * 42)
        print("  1. Lister les projets")
        print("  2. Créer un projet")
        print("  3. Lister les variables d'un environnement")
        print("  4. Définir une variable")
        print("  5. Importer un fichier .env")
        print("  0. Retour")
        print("─" * 42)
        choice = input("Votre choix : ").strip()
        ns = argparse.Namespace(master_stdin=False)
        try:
            if choice == "1":
                cmd_project_list(ns)
            elif choice == "2":
                ns.name = input("Nom du projet : ").strip()
                ns.desc = input("Description (optionnel) : ").strip()
                ns.env = ""
                cmd_project_add(ns)
            elif choice == "3":
                ns.project = input("Projet : ").strip()
                ns.env = input("Environnement [local] : ").strip() or "local"
                cmd_list(ns)
            elif choice == "4":
                ns.project = input("Projet : ").strip()
                ns.env = input("Environnement [local] : ").strip() or "local"
                ns.key = input("Clé : ").strip()
                ns.stdin = False
                ns.generate = None
                ns.masked = None
                ns.protected = None
                ns.file = False
                cmd_set(ns)
            elif choice == "5":
                ns.project = input("Projet : ").strip()
                ns.env = input("Environnement [local] : ").strip() or "local"
                ns.file = input("Chemin du fichier .env : ").strip()
                ns.no_overwrite = False
                cmd_import(ns)
            elif choice == "0":
                return
            else:
                print("  → Choix invalide, tapez 0-5.")
        except (SecretsVaultError, ProviderError) as exc:
            print(f"  Erreur : {exc}")

