"""Copie dans le presse-papier du système."""

import subprocess
import sys


def copy(text: str) -> bool:
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

