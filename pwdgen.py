#!/usr/bin/env python3
"""Point d'entrée de robust-pwd (commande ``robust-pwd``)."""

import sys
from pathlib import Path

# Permet le lancement via un lien symbolique (~/.local/bin/robust-pwd).
sys.path.insert(0, str(Path(__file__).resolve().parent))

from robust_pwd.cli import main  # noqa: E402

if __name__ == "__main__":
    main()
