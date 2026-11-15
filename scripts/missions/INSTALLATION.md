# Mission Creator pour HeavyMP

Le module ajoute la commande `/script missions` au chat en jeu. Les missions créées apparaissent dans l’application Missions de HeavyMP et utilisent le service de missions du serveur.

## Installation

1. Arrête le jeu depuis le Manager avant de configurer le script intégré.
2. Ajoute les empreintes des clients autorisés dans `missionCreators` dans `scripts/missions/manifest.json`. La liste est vide au premier démarrage.
3. Dans **Scripts**, active **Mission Creator** et garde **Phone** actif pour accéder à l’application Missions. Redémarre le serveur de jeu.

Le client fourni affiche son empreinte avec `npm run client:fingerprint`. Il faut conserver son fichier d’identité local.

## Créer et prendre une mission

Saisis la commande suivante dans le chat du jeu.

```text
/script missions new <public|private> <source> <destination> <cargo> <trailer> <units> <km> [title]
```

Les valeurs de `source` et `destination` sont les identifiants `entreprise.ville` des dépôts. `cargo` est l’identifiant `cargo.*` et `trailer` l’identifiant `trailer_def.*` compatible avec ce fret. `units` indique le nombre d’unités et `km` la distance prévue en kilomètres. Sur IDF, utilise les dépôts et les définitions de fret disponibles sur les addons actifs de ton serveur.

Cet exemple utilise des identifiants de la carte Europe.

```text
/script missions new public euroacres.erfurt sellplan.lodz cargo.pears trailer_def.schmitz.sko.single_3.reefer 33 646 Convoi du soir
```

Une fois le message de confirmation reçu, ouvre **Missions → Mine**, sélectionne la mission et clique sur **Start delivery** pour la prendre dans ETS2. Les joueurs voient les missions publiques dans **Explore**. Pour une mission privée, invite-les depuis la fiche de la mission.

## Trajets réutilisables

Ajoute tes trajets à `scripts/missions/routes.json`. Le nom court (par exemple `convoi-du-soir`) doit utiliser des minuscules, des chiffres ou des tirets. Cet exemple utilise de nouveau la carte Europe.

```json
{
  "convoi-du-soir": {
    "title": "Convoi du soir",
    "visibility": "public",
    "source": "euroacres.erfurt",
    "destination": "sellplan.lodz",
    "cargo": "cargo.pears",
    "trailerDefinition": "trailer_def.schmitz.sko.single_3.reefer",
    "unitsCount": 33,
    "distanceKm": 646
  }
}
```

Redémarre le serveur de jeu après avoir modifié le fichier. Utilise `/script missions list` pour afficher tes trajets et `/script missions create convoi-du-soir` pour créer une mission à partir de l’un d’eux.
