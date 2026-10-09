# Journal des modifications

Les versions antérieures à la 1.2.0 sont décrites dans les
[releases GitHub](https://github.com/slemeur91/local_agenda/releases).

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
