# Journal des modifications

Les versions antérieures à la 1.2.0 sont décrites dans les
[releases GitHub](https://github.com/slemeur91/local_agenda/releases).

## 1.4.0 – 2026-11-10

Nouvelle interface du panneau (panel.js 2.0.0), inspirée de celle
d'[agenda-ha](https://github.com/jolabs40/agenda-ha), sur le moteur de
Local Agenda.

### Panneau

- **Cinq vues** : Semaine (une journée sur téléphone), Mois, Maison (tous les
  agendas sur une journée, la ligne d'un agenda se dédoublant quand ses
  événements se croisent), Liste et Exécutions (actions prévues dans les
  24 heures et dernières exécutions).
- **Glisser-déposer** à la souris dans la vue Semaine : déplacer un événement,
  y compris vers un autre jour, ou tirer son bord bas pour changer sa fin ;
  pour un événement récurrent, choix de la portée.
- **Éditeur d'événement complet** : portée (celle-ci, et les suivantes, toute
  la série), titre, couleur, icône, agenda, horaires, répétition (avec règle
  personnalisée), conditions et actions de début et de fin, note ; supprimer
  et dupliquer.
- **Conditions** : état d'une entité, valeur numérique (au-dessus, en
  dessous, entre), ou YAML ; badges « remplie / non remplie » en direct.
- **Actions** : thermostat, allumer / éteindre, option, attente,
  notification (variables à insérer et aperçu), scène ou script, « si…
  alors… sinon », autre service, YAML ; vérifiées par Home Assistant à
  l'enregistrement.
- **Cartes** de conditions et d'actions : poignée de déplacement à gauche,
  copier, supprimer (avec annulation), flèche de repli à droite.
- **Colonne des agendas** : affichage, état en cours ou prochain événement,
  suspension, couleur, renommage, création d'un agenda ; autres calendriers
  de Home Assistant affichés hachurés, pour information.

### Moteur

- Couleur (`COLOR`, RFC 7986) et icône par événement, conservées par toutes
  les modifications, y compris depuis le calendrier de Home Assistant.
- Suspension d'un agenda : plus aucune action tant qu'il est suspendu.
- Historique des 100 dernières exécutions, enregistré avec l'état du
  scheduleur.
- Nouvelles commandes WebSocket pour le panneau (occurrences, lecture et
  enregistrement d'un événement par portée, suppression, réglages d'un
  agenda, création d'un agenda, historique, YAML).
- Le nom affiché d'un agenda suit le titre de son entrée, qui peut être
  renommé ; le fichier `.ics` garde son nom.

## 1.3.0 – 2026-11-10

Le moteur reprend trois idées de l'intégration
[agenda-ha](https://github.com/jolabs40/agenda-ha) : un déclenchement sans
transition perdue, l'exécution des actions par le moteur de scripts de Home
Assistant et les conditions sur un seuil numérique.

### Ajouts

- **Actions exécutées comme des scripts Home Assistant** : la syntaxe des
  automatisations est acceptée (`action:` ou `service:`, `delay`,
  `wait_template`, `if`, `choose`, modèles Jinja…), avec trois variables :
  `agenda`, `phase` (`start` / `stop`) et `event` (`summary`, `start`, `end`,
  `uid`, `description`, `location`, `all_day`).
- **Condition `numeric_state`** : au-dessus et/ou en dessous d'un seuil, sur
  l'état ou sur un attribut (`attribute`).
- **Rattrapage après un redémarrage** : le début d'un événement encore en
  cours et la fin d'un événement commencé avant l'arrêt sont exécutés au
  redémarrage (sur 7 jours au plus).
- **Événement supprimé, déplacé ou raccourci pendant qu'il est en cours** :
  son `on_stop` est exécuté aussitôt.
- Le panneau vérifie les actions à l'enregistrement et refuse un bloc
  invalide.

### Changements

- **Déclenchement à l'heure exacte** : un minuteur est posé sur chaque
  transition (auparavant jusqu'à 20 secondes de retard). La fenêtre de
  22 secondes et la mémoire des déclenchements disparaissent : chaque début
  et chaque fin est traité une fois et une seule, redémarrage compris.
- À la même heure, les fins sont exécutées avant les débuts.
- Les actions s'exécutent en arrière-plan : un `delay` ne retarde pas les
  autres événements.

### Compatibilité

- Les blocs écrits pour les versions précédentes fonctionnent sans
  changement : une liste composée uniquement d'appels de service garde son
  comportement (chaque appel part de son côté, sans attendre le précédent,
  et un appel en échec n'empêche pas les suivants).
- Seule différence possible : une valeur contenant `{{ ... }}` est désormais
  évaluée comme un modèle.
- **Panneau (panel.js 1.10.0)** : les actions qui ne sont pas un simple appel
  de service (`delay`, `if`, données imbriquées, valeurs booléennes…) sont
  affichées en lecture seule et conservées telles quelles à la sauvegarde ;
  `action:` est reconnu comme `service:`. Les conditions `numeric_state` ont
  leur badge « remplie / non remplie ».

### Technique

- Nouveau module `scheduler.py` ; l'état du scheduleur est enregistré dans
  `config/.storage/local_agenda.scheduler.<entry_id>` et supprimé avec
  l'agenda.
- Nouvelle suite de tests `tests_ha/`, exécutée dans un vrai Home Assistant
  (moteur de scripts, minuteurs, stockage).

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
