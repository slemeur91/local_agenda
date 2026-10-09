# Journal des modifications

Les versions antérieures à la 1.2.0 sont décrites dans les
[releases GitHub](https://github.com/slemeur91/local_agenda/releases).

## 1.2.2 – 2026-10-09

Version de corrections issue d'un audit du code.

### Changements de comportement

- **Le panneau Local Agenda et son API sont réservés aux administrateurs.**
  Un utilisateur non administrateur pouvait y définir des appels de service
  exécutés ensuite sans contrôle de droits.
- **Une condition d'un type inconnu est désormais considérée comme non
  remplie** (elle était considérée comme vraie). Une faute de frappe dans le
  type ne rend plus une action inconditionnelle.
- `state: on` et `state: off` écrits sans guillemets sont compris comme les
  états `on` et `off` (ils ne correspondaient jamais).

### Corrections

- **Panneau (panel.js 1.9.1)** : le titre de l'événement et le nom du
  calendrier sont échappés avant affichage (injection HTML possible).
- **Sauvegarde des actions** : une valeur contenant `\` (chemin Windows,
  expression régulière, `\n`…) faisait échouer ou altérait la deuxième
  sauvegarde d'un événement.
- **Actions des occurrences déplacées** : les actions enregistrées depuis le
  panneau sont aussi écrites dans les occurrences modifiées individuellement,
  qui conservaient les anciennes.
- **Modification d'une seule occurrence** : changer uniquement le titre, la
  description ou le lieu d'une occurrence ne modifie plus toute la série.
- **Modification de toute la série** : les occurrences supprimées ou
  déplacées ne sont plus réinitialisées quand l'heure de début n'a pas
  changé.
- **« Cet événement et les suivants »** : la nouvelle série n'hérite plus
  d'une règle de récurrence déjà terminée ; à la suppression, les occurrences
  déplacées situées après la coupure sont retirées elles aussi.
- **Scheduleur** : une erreur sur un événement n'empêche plus les autres
  événements du même tick de se déclencher ; les événements sans fuseau
  horaire sont lus en heure locale.
- **Fichier de stockage** : écriture atomique (plus de fichier tronqué en cas
  de coupure), fichier illisible signalé clairement et laissé intact.
- **Nom du fichier** : deux agendas ne peuvent plus partager le même fichier
  (« Mon agenda » et « mon_agenda »), et un nom ne peut plus créer de
  sous-dossier ni sortir du dossier de stockage. Les fichiers existants
  gardent leur nom.
- **Erreurs remontées à l'interface** : une création ou une modification
  impossible (événement introuvable, règle de récurrence invalide) affiche
  une erreur au lieu d'échouer en silence.
- Les événements créés portent un `DTSTAMP`, obligatoire dans la norme
  iCalendar.

### Technique

- Moins de calculs : le calendrier est développé en une seule passe, et la
  recherche du prochain événement commence par une fenêtre d'une semaine.
- `manifest.json` : dépendances `http`, `frontend` et `websocket_api`
  déclarées, `iot_class` corrigé en `local_polling`.
- Traductions : `strings.json` en anglais, messages d'erreur ajoutés en
  français et en anglais.
- `calendar.py` réorganisé en fonctions courtes ; suppression de deux
  commandes WebSocket inutilisées.
- Ajout d'une suite de tests (`tests/`).

## 1.2.1 – 2026-10-09

### Documentation

- README simplifié : le détail de la syntaxe, les exemples et le
  fonctionnement interne sont désormais dans le
  [wiki du projet](https://github.com/slemeur91/local_agenda/wiki).
- Ajout d'une version anglaise du README (`README_en.md`).
- Captures d'écran refaites dans un format plus compact, avec des versions
  anglaises dans `images/en/`.

## 1.2.0 – 2026-10-09

### Ajouts

- **Panneau Local Agenda (panel.js 1.9.0) : refonte des conditions.**
  - Chaque condition est une carte repliable, résumée sur une ligne.
  - Les états se choisissent par boutons (choix multiple) proposés selon
    l'entité, avec saisie libre pour un état non listé.
  - Comparaison « est » / « n'est pas ».
  - Sélecteur ET / OU pour relier les conditions.
  - Badges « remplie / non remplie » mis à jour en direct, pour chaque
    condition et pour la règle entière.
  - Les conditions écrites à la main que le formulaire ne sait pas
    représenter sont affichées en lecture seule et conservées telles quelles
    à la sauvegarde.
  - La sauvegarde est refusée tant qu'une condition est incomplète.

### Corrections

- **Scheduleur : double exécution possible de `on_start` / `on_stop`.**
  La purge des clés de déduplication analysait la clé avec `split(":")`,
  alors que l'horodatage ISO qu'elle contient comporte lui-même des « : ».
  Lorsque l'heure de l'événement était exprimée en UTC ou dans un fuseau à
  l'ouest d'UTC, la clé était purgée dès le tick suivant et l'action pouvait
  être rejouée. À l'est d'UTC, la clé était au contraire conservée 1 à
  2 heures au lieu de 10 minutes. Les clés sont désormais stockées avec leur
  date de déclenchement UTC et purgées sur cette valeur.
- **Création d'un agenda : libellé du champ.** Le champ affichait
  `calendar_name` au lieu de « Nom du calendrier », les fichiers de
  traduction utilisant la clé `name`.

### Documentation

- Ajout d'un lien vers le [wiki du projet](https://github.com/slemeur91/local_agenda/wiki)
  dans le README.
- Ajout de ce journal des modifications.
