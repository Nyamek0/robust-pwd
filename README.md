# robust-pwd

Générateur de mots de passe robuste avec coffre chiffré local.

Génère des mots de passe forts à la manière d'Apple (prononçable) ou Google (aléatoire), et les sauvegarde dans un fichier chiffré AES-256-GCM sur ta machine. Aucune donnée n'est envoyée sur internet.

---

## Fonctionnalités

- Deux styles de mots de passe : **Apple** (`xovuk-8Nevqe-hidwuf`) et **Google** (`Kj#9mLpQ2$vXn8!wR`)
- Chaque mot de passe est associé à un **mot clé** (ex : GitHub, Netflix)
- Coffre chiffré **AES-256-GCM** avec dérivation de clé PBKDF2 (600 000 itérations)
- Mot de passe maître défini par l'utilisateur — jamais stocké dans le code
- Copie automatique dans le presse-papier
- Fonctionne en mode **menu interactif** ou **sous-commandes directes**

---

## Prérequis

- **Python 3.8+**
- **pip**

Vérifier ta version de Python :
```bash
python3 --version
```

---

## Installation

### 1. Cloner le dépôt

```bash
git clone https://github.com/<ton-utilisateur>/robust-pwd.git
cd robust-pwd
```

### 2. Installer la dépendance

```bash
pip install -r requirements.txt
```

> Si `pip` ne fonctionne pas, essaie `pip3` ou `python3 -m pip install -r requirements.txt`.

---

## Lancer le script

Sans commande globale, tu peux toujours lancer le script directement :

```bash
python3 pwdgen.py
```

---

## Commande globale `robust-pwd` (optionnel mais recommandé)

Cette étape te permet de taper `robust-pwd` depuis n'importe quel terminal.

### macOS / Linux

```bash
# Rendre le script exécutable
chmod +x pwdgen.py

# Créer le dossier s'il n'existe pas
mkdir -p ~/.local/bin

# Créer un lien symbolique
ln -sf "$(pwd)/pwdgen.py" ~/.local/bin/robust-pwd
```

Ensuite, ajouter `~/.local/bin` à ton PATH si ce n'est pas déjà fait.

**macOS (zsh) :**
```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

**Linux (bash) :**
```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

Vérifier que ça fonctionne :
```bash
robust-pwd
```

---

### Windows

**Option A — PowerShell (recommandée)**

1. Ouvre PowerShell en tant qu'administrateur et crée un dossier pour tes scripts :

```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\scripts"
```

2. Crée un fichier `robust-pwd.bat` dans ce dossier :

```powershell
$scriptPath = (Get-Location).Path + "\pwdgen.py"
$batContent = "@echo off`r`npython `"$scriptPath`" %*"
Set-Content "$env:USERPROFILE\scripts\robust-pwd.bat" $batContent
```

3. Ajoute ce dossier au PATH :

```powershell
$path = [System.Environment]::GetEnvironmentVariable("PATH", "User")
[System.Environment]::SetEnvironmentVariable("PATH", "$path;$env:USERPROFILE\scripts", "User")
```

4. **Redémarre** PowerShell, puis teste :

```powershell
robust-pwd
```

**Option B — Raccourci manuel**

Dans l'invite de commandes (cmd), tu peux toujours lancer :
```cmd
python pwdgen.py
```

> **Note Windows** : La copie dans le presse-papier fonctionne nativement via `clip`. Aucun logiciel supplémentaire requis.

---

## Note Linux — presse-papier

Sur Linux, le script utilise `xclip` pour copier dans le presse-papier. Installe-le si besoin :

```bash
# Debian / Ubuntu
sudo apt install xclip

# Fedora / RHEL
sudo dnf install xclip

# Arch
sudo pacman -S xclip
```

> Sans `xclip`, le script fonctionne normalement — le mot de passe s'affiche à l'écran mais n'est pas copié automatiquement.

---

## Utilisation

### Premier lancement

Au tout premier lancement, le script crée ton coffre et te demande de choisir un mot de passe maître :

```
Bienvenue dans robust-pwd !
Aucun coffre trouvé. Créez votre mot de passe maître.

Créez votre mot de passe maître :
Confirmez votre mot de passe maître :

✓ Coffre initialisé avec succès.
```

> Ce mot de passe maître **n'est pas récupérable**. Si tu l'oublies, tu perdras l'accès au coffre.

---

### Mode menu interactif

Lance `robust-pwd` sans argument :

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  robust-pwd — Gestionnaire de mots de passe
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  1. Générer un mot de passe
  2. Lister les mots de passe
  3. Afficher un mot de passe
  4. Supprimer un mot de passe
  0. Quitter
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Votre choix :
```

Tape un numéro et appuie sur Entrée.

---

### Mode sous-commandes directes

Tu peux aussi aller directement à une action :

| Commande | Description |
|---|---|
| `robust-pwd generate` | Générer et sauvegarder un nouveau mot de passe |
| `robust-pwd list` | Lister tous les mots de passe (sans afficher les mots de passe) |
| `robust-pwd show` | Afficher le mot de passe d'une entrée |
| `robust-pwd delete` | Supprimer une entrée |

---

### Exemple complet — générer un mot de passe

```
$ robust-pwd generate

Style de mot de passe :
  1. Apple  (prononçable)    ex: xovuk-8Nevqe-hidwuf
  2. Google (aléatoire fort)  ex: Kj#9mLpQ2$vXn8!wR
  3. Les deux
Choix [1/2/3] : 3

  [Apple]  pasiq-z6eket-Huhef
  [Google] $#5$9^SSz8Ba4$ddo2

Lequel utiliser ?  1 = Apple  2 = Google
Choix [1/2] : 1

Copié dans le presse-papier.

Mot clé associé (ex: GitHub, Netflix) : GitHub
Mot de passe maître du coffre :

✓ Enregistré → ID 1  |  mot clé : « GitHub »
```

---

### Lister les mots de passe

```
$ robust-pwd list

Mot de passe maître du coffre :

  ID    Mot clé                   Style    Date
  ──────────────────────────────────────────────────────
  1     GitHub                    apple    2026-06-09T18:30:00
  2     Netflix                   google   2026-06-09T18:45:00
```

Les mots de passe ne sont pas affichés. Utilise `show` pour en voir un.

---

### Afficher un mot de passe

```
$ robust-pwd show

Mot de passe maître du coffre :

  ID    Mot clé    ...
  1     GitHub
  2     Netflix

ID à afficher : 1

  Mot clé     : GitHub
  Style       : apple
  Date        : 2026-06-09T18:30:00
  Mot de passe: pasiq-z6eket-Huhef

  Copié dans le presse-papier.
```

---

## Sécurité

| Élément | Détail |
|---|---|
| Algorithme de chiffrement | AES-256-GCM (authentifié) |
| Dérivation de clé | PBKDF2-HMAC-SHA256, 600 000 itérations |
| Sel | 16 octets aléatoires par écriture |
| Emplacement du coffre | `~/.robust-pwd/vault.enc` |
| Permissions du fichier | `600` (lecture/écriture uniquement par ton utilisateur) |
| Génération des mots de passe | Module `secrets` Python (cryptographiquement sûr) |

Le coffre est un fichier binaire illisible sans le mot de passe maître. Toute modification du fichier est détectée grâce à l'authentification GCM.

---

## Désinstaller

```bash
# Supprimer le coffre
rm -rf ~/.robust-pwd

# Supprimer le lien symbolique (macOS/Linux)
rm ~/.local/bin/robust-pwd

# Supprimer le dossier cloné
rm -rf /chemin/vers/robust-pwd
```
