# Local Agenda

[![GitHub Release][releases-shield]][releases]
[![hacs_badge](https://img.shields.io/badge/HACS-Custom-41BDF5.svg?style=flat-square)](https://github.com/hacs/integration)
[![Maintainers](https://img.shields.io/badge/maintainers-@slemeur91-blue.svg?style=flat-square)](#)

Un composant personnalisé pour Home Assistant qui étend l'intégration `local_calendar` en ajoutant la possibilité de déclencher des services Home Assistant au début et/ou à la fin d'événements.

## Installation

## HACS

[![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=slemeur91&repository=local_agenda&category=integration)

### Manuellement

1. Copiez le dossier `local_agenda` dans `config/custom_components/` de votre installation Home Assistant.
2. Redémarrez Home Assistant.
3. **Paramètres → Appareils et services → Ajouter une intégration → Local Agenda**.

## Syntaxe des actions

Les événements peuvent inclure un bloc spécial `---actions---` dans leur description pour définir les services à déclencher au début ou à la fin de l'événement. Le bloc utilise la syntaxe YAML :

```
---actions---
on_start:
  conditions:
	- condition: state
	  entity_id: input_select.nom_de_la_condition
		state: Etat
  actions:
    - service: domaine.nom_du_service
      data: {}
      target:
        entity_id:
          - switch.mon_interrupteur
on_stop:
  actions:
    - service: domaine.nom_du_service
      data: {}
      target:
        entity_id:
          - switch.mon_interrupteur
---/actions---
```

`on_start` et `on_stop` sont tous deux des listes optionnelles d'appels de service. Chaque appel de service prend en charge :
- `service` : Obligatoire. Format : `domaine.nom_du_service` (ex. : `switch.turn_on`)
- `target` : Optionnel. Dictionnaire avec `entity_id` ou d'autres informations de ciblage
- `data` : Optionnel. Paramètres supplémentaires du service
- `entity_id` : Optionnel. Raccourci pour `target: {entity_id: ...}`

## Exemples

### Exemple 1 : Allumer un interrupteur au début de l'événement, l'éteindre à la fin

Description de l'événement :
```
Session d'arrosage de la pelouse

---actions---
on_start:
  actions:
    - service: switch.turn_on
      target:
        entity_id:
          - switch.arrosage_pelouse
on_stop:
  actions:
    - service: switch.turn_off
      target:
        entity_id:
          - switch.arrosage_pelouse
---/actions---
```

### Exemple 2 : Démarrer les aspirateurs robots

Description de l'événement :
```
Passage des aspirateurs

---actions---
on_start:
  actions:
    - service: vacuum.start
      target:
        entity_id:
          - vacuum.aspirateur_du_bas
          - vacuum.aspirateur_de_l_etage
---/actions---
```

### Exemple 3 : Positionnement de la valeur d'un interrupteur

Description de l'événement :
```
Activation du Chauffage Hors Gel

---actions---
on_start:
  actions:
    - service: input_boolean.turn_on
      target:
        entity_id:
          - input_boolean.chauffage_horsgel
---/actions---
```

### Exemple 4 : Positionnement d'un valeur sur une liste déroulante lorsqu'une condition est valide

Description de l'événement :
```
Positionnement du Chauffage du Rez De Chaussé en Réduit
Appliqué lorsque la condition Calendrier est sur Absent

---actions---
on_start:
  conditions:
	- condition: state
	  entity_id: input_select.calendrier
		state: Absent
  actions:
    - service: input_select.select_option
      data:
        option: Réduit
      target:
        entity_id:
          - input_select.chauffage_mode_rdc
---/actions---
```

## Fonctionnement

- Le composant interroge toutes les 20 secondes pour vérifier si des heures de début ou de fin d'événements tombent dans la fenêtre temporelle actuelle.
- Lorsque l'heure de début d'un événement est atteinte, toutes les actions du bloc `on_start` sont exécutées.
- Lorsque l'heure de fin d'un événement est atteinte, toutes les actions du bloc `on_stop` sont exécutées.
- Chaque action n'est déclenchée qu'une seule fois par occurrence d'événement ; le composant enregistre les horodatages des actions déclenchées pour éviter les doublons.
- Si Home Assistant est redémarré, les actions sont à nouveau déclenchées si la fenêtre temporelle de l'événement chevauche la période d'interrogation.
- Les actions sont journalisées au niveau INFO. Les erreurs d'appel de service sont enregistrées mais n'interrompent pas la boucle d'exécution.

## Limitations

- La granularité d'interrogation est de 20 secondes ; les actions se déclenchent avec une précision d'environ 20 secondes.
- Si Home Assistant est hors ligne lors d'une transition d'événement, le déclenchement rétroactif n'a pas lieu par défaut.
- Les heures des événements doivent être renseignées dans les champs `dtstart` et `dtend` du fichier ICS.
- Les événements récurrents fonctionnent, mais les remplacements spécifiques à une instance récurrente sont développés au moment du chargement.

## Stockage

Les événements du calendrier sont stockés dans `.storage/local_agenda.{nom_du_calendrier}.ics` afin d'éviter les conflits avec l'intégration native `local_calendar`.
