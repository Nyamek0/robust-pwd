# Spécification — coffre de secrets applicatifs (v1)

Ce document est la **source de vérité** partagée par le CLI Python (`robust_pwd/`) et
l'application desktop (`desktop/`). Toute évolution du format doit d'abord être décrite
ici, puis couverte par les fixtures de `tests/fixtures/`.

---

## 1. Fichier

| Élément | Valeur |
|---|---|
| Emplacement par défaut | `~/.robust-pwd/secrets.enc` |
| Surcharge | variable d'environnement `ROBUST_PWD_SECRETS_VAULT` |
| Dossier | créé en `700` |
| Fichier | `600`, écriture atomique (fichier temporaire dans le même dossier puis `rename`) |
| Mot de passe maître | indépendant de celui de `vault.enc`, 8 à 1024 caractères |

### 1.1 Format binaire

Identique à `vault.enc` :

```
salt (16 octets) ‖ nonce (12 octets) ‖ ciphertext ‖ tag GCM (16 octets)
```

- Clé : PBKDF2-HMAC-SHA256, 600 000 itérations, 32 octets, dérivée du mot de passe maître et du sel.
- Chiffrement : AES-256-GCM, sans données associées.
- Le nonce est régénéré à **chaque** écriture. Le sel peut être conservé tant que le mot de passe
  maître ne change pas (le desktop garde la clé dérivée en mémoire), et est régénéré lors d'un
  changement de mot de passe maître.
- Le texte clair est un document JSON encodé en UTF-8 (§2).

---

## 2. Contenu déchiffré

```json
{
  "kind": "robust-pwd/secrets",
  "version": 1,
  "projects": [ Project, ... ],
  "credentials": [ Credential, ... ]
}
```

Un lecteur **doit** refuser un document dont `kind` n'est pas `"robust-pwd/secrets"`
(par exemple un `vault.enc` de mots de passe) ou dont `version` est supérieure à celle
qu'il connaît. Les champs inconnus sont conservés tels quels à la réécriture.

### 2.1 Project

| Champ | Type | Règle |
|---|---|---|
| `id` | entier | ≥ 1, unique, jamais réutilisé dans un même fichier (max + 1) |
| `name` | chaîne | `^[A-Za-z0-9._-]{1,64}$`, unique (comparaison sensible à la casse) |
| `description` | chaîne | 0–200 caractères |
| `created_at`, `updated_at` | chaîne | horodatage local ISO 8601 à la seconde, sans fuseau : `YYYY-MM-DDTHH:MM:SS` |
| `remote` | Remote ou `null` | fournisseur distant relié au projet |
| `environments` | Environment[] | 0–20 éléments, noms uniques |

À la création d'un projet sans précision, les environnements `local`, `staging` et
`production` sont créés, avec `remote_scope` à `null`.

### 2.2 Remote

| Champ | Type | Règle |
|---|---|---|
| `provider` | chaîne | `"gitlab"` ou `"github"` |
| `host` | chaîne | URL `https://…` sans `/` final. GitLab : `https://gitlab.com` par défaut. GitHub : `https://api.github.com` par défaut |
| `target` | chaîne | GitLab : chemin `groupe[/sous-groupe]/projet`. GitHub : `propriétaire/dépôt` |

### 2.3 Environment

| Champ | Type | Règle |
|---|---|---|
| `name` | chaîne | `^[a-z0-9._-]{1,32}$` |
| `remote_scope` | chaîne ou `null` | `null` : non synchronisé. `"*"` : GitLab = toutes portées, GitHub = secrets du dépôt. Autre valeur (1–255 caractères) : GitLab = `environment_scope`, GitHub = nom d'environnement |
| `variables` | Variable[] | 0–1000 éléments, clés uniques |

### 2.4 Variable

| Champ | Type | Défaut | Règle |
|---|---|---|---|
| `key` | chaîne | — | `^[A-Za-z_][A-Za-z0-9_]{0,254}$` |
| `value` | chaîne | — | 0–65 536 caractères, multi-ligne autorisé |
| `masked` | booléen | `false` | GitLab uniquement |
| `protected` | booléen | `false` | GitLab uniquement |
| `raw` | booléen | `true` | GitLab uniquement (pas d'expansion de `$VAR`) |
| `type` | chaîne | `"env_var"` | `"env_var"` ou `"file"` |
| `updated_at` | chaîne | — | même format que `created_at` |

### 2.5 Credential

| Champ | Type | Règle |
|---|---|---|
| `provider` | chaîne | `"gitlab"` ou `"github"` |
| `host` | chaîne | même règle que `Remote.host` ; unique par couple (`provider`, `host`) |
| `token` | chaîne | 1–512 caractères, jamais affiché après saisie |
| `added_at` | chaîne | horodatage |

### 2.6 Limites globales

- Fichier chiffré : 10 Mo maximum.
- 200 projets maximum.

---

## 3. Format `.env`

Le parseur et le sérialiseur existent en double (Python et TypeScript) et doivent produire
**exactement** les mêmes résultats sur `tests/fixtures/dotenv/`.

### 3.1 Lecture

1. Un BOM UTF-8 initial est ignoré ; `\r\n` et `\r` isolés sont convertis en `\n`.
2. Le texte est lu ligne par ligne (numérotées à partir de 1).
3. Les espaces et tabulations en début de ligne sont ignorés. Ligne vide ou commençant par `#` : ignorée.
4. Un préfixe `export` suivi d'au moins un espace ou une tabulation est retiré.
5. La ligne doit ensuite correspondre à `^([A-Za-z_][A-Za-z0-9_]*)[ \t]*=` ; sinon elle est **invalide**.
6. Le reste après `=` (appelé *brut*) est interprété :
   - Après avoir ignoré les espaces/tabulations de tête, s'il commence par `"` : valeur entre
     guillemets doubles. Elle se termine au premier `"` non échappé, éventuellement sur une ligne
     suivante (les lignes sont jointes par `\n`). Échappements reconnus : `\n`, `\r`, `\t`, `\"`,
     `\\`. Toute autre séquence `\x` est conservée telle quelle (deux caractères), de même qu'un
     `\` en fin de ligne.
   - S'il commence par `'` : valeur entre guillemets simples, littérale, se terminant au `'`
     suivant, éventuellement sur une ligne suivante. Aucun échappement.
   - Après le guillemet fermant, le reste de la ligne doit être vide, ou des espaces/tabulations
     suivis éventuellement d'un commentaire `#…`. Sinon la ligne de départ est **invalide**.
   - Guillemet jamais fermé : la ligne de départ est **invalide** et la lecture reprend à la
     ligne suivante.
   - Sinon (valeur sans guillemets) : un `#` précédé d'un espace ou d'une tabulation commence un
     commentaire ; la valeur est le *brut* avant ce commentaire, débarrassé des espaces et
     tabulations de tête et de fin. Un `#` collé (`a#b`, `KEY=#x`) fait partie de la valeur.
7. Aucune interpolation (`${VAR}`, `$VAR`) : la valeur est conservée telle quelle.
8. Clé répétée : la **dernière** valeur l'emporte, la variable garde la position de sa **première**
   apparition, et la clé est ajoutée (une seule fois) à la liste `duplicates`.

Résultat :

```json
{
  "variables": [ { "key": "A", "value": "1" } ],
  "duplicates": [ "A" ],
  "invalid_lines": [ 4, 9 ]
}
```

Les rapports ne contiennent **jamais** de valeur, seulement des clés et des numéros de ligne.

### 3.2 Écriture (`dotenv`)

Une ligne `KEY=…` par variable, dans l'ordre, terminée par `\n`.

- Valeur vide : `KEY=`.
- Valeur composée uniquement de `[A-Za-z0-9_./:@%+,=-]` : écrite telle quelle.
- Sinon, si elle ne contient ni `'`, ni `\n`, ni `\r` : entre guillemets simples (`KEY='a b $c'`),
  ce qui évite toute interpolation par d'autres outils.
- Sinon : entre guillemets doubles, en échappant `\` → `\\`, `"` → `\"`, saut de ligne → `\n`,
  retour chariot → `\r`, tabulation → `\t`.

Propriété garantie : `parse(serialize(vars)).variables == vars`.

### 3.3 Écriture (`shell`)

`export KEY='valeur'` par ligne, où chaque `'` de la valeur devient `'\''`.

### 3.4 Écriture (`json`)

Objet `{ "KEY": "valeur", … }` dans l'ordre des variables, indenté de 2 espaces, suivi de `\n`.

---

## 4. Fichier projet `.robust-pwd.json`

Ne contient **aucun secret**, destiné à être commité à la racine d'un dépôt :

```json
{ "project": "mon-api", "environment": "local" }
```

| Champ | Règle |
|---|---|
| `project` | obligatoire, même règle que `Project.name` |
| `environment` | facultatif, même règle que `Environment.name`, `local` par défaut |

Recherche : dossier courant, puis parents successifs ; arrêt après le premier dossier
contenant `.git`, ou à la racine du système de fichiers. Les arguments explicites de la ligne de
commande sont toujours prioritaires.

---

## 5. Synchronisation distante

### 5.1 Plan

Entrées : variables locales d'un environnement (`remote_scope` non nul) et variables distantes du
même scope. Pour chaque clé (comparaison exacte pour GitLab, insensible à la casse pour GitHub) :

| Situation | Action |
|---|---|
| Locale seulement | `create` |
| Des deux côtés, fournisseur lisible, valeur et attributs identiques | `unchanged` |
| Des deux côtés, fournisseur lisible, différence | `update` |
| Des deux côtés, fournisseur non lisible (GitHub) | `overwrite` |
| Distante seulement, option `prune` | `delete` |
| Distante seulement, sans `prune` | `keep` |

Le plan est trié par action (`create`, `update`, `overwrite`, `delete`, `keep`, `unchanged`) puis
par clé. Il est validé par le fournisseur avant application ; une seule erreur bloque l'ensemble.

### 5.2 Validation GitLab

- Variable `masked` : valeur d'au moins 8 caractères, sur une seule ligne, composée uniquement de
  caractères Base64 étendus (`A-Z a-z 0-9 + / = @ : . ~ -` et `_`).
- Valeur ≤ 10 000 caractères.

### 5.3 Validation GitHub

- Nom : `^[A-Za-z_][A-Za-z0-9_]*$`, ne commence pas par `GITHUB_` (insensible à la casse).
- Valeur ≤ 48 Ko (UTF-8), non vide.
