# FENECON FEMS / OpenEMS

Intégration non officielle, sans lien avec FENECON ni l'association OpenEMS.
Elle lit un système de stockage **FENECON FEMS** (Home, Commercial) ou tout
**Edge OpenEMS** sur votre réseau, par l'API locale JSON-RPC WebSocket de
l'Edge. **Lecture seule** : elle ne change jamais un réglage du système. Sans
cloud : le portail FENECON n'est jamais contacté.

**Jamais testé avec un vrai appareil** : construite à partir de l'API telle
que l'utilise l'intégration Home Assistant ha_openems. Vos retours sont les
bienvenus.

## Ce que vous obtenez

Un appareil par Edge, nommé d'après son nom d'hôte (ex. `OpenEMS fems12345`) :

- état de charge (%) ;
- puissance de la batterie (W, signée : + décharge, - charge) ;
- puissance réseau (W, signée : + achetée au réseau, - vendue au réseau) ;
- puissance de production (W) et consommation de la maison (W) ;
- les compteurs d'énergie à vie (kWh) : production, consommation de la
  maison, achat au réseau, vente au réseau, charge et décharge de la
  batterie ;
- l'état du système (0 OK, 1 info, 2 avertissement, 3 défaut) et le mode
  réseau (1 raccordé, 2 îloté) ;
- un **index de production** pour le suivi énergétique de Gladys (option
  « Production »).

La consommation de la maison et l'achat au réseau sont des capteurs simples,
non comptés par le suivi énergétique : votre compteur principal les compte
déjà (ils seraient facturés deux fois).

## Configuration

1. Donnez à l'Edge une adresse fixe dans votre box.
2. Dans Gladys, installez l'intégration et remplissez :
   - **Adresse de l'Edge** : son adresse IP ; ajoutez un port seulement s'il
     n'est pas 8085 (`:80` passe par le WebSocket de la page web du FEMS) ;
   - **Identifiant** : laissez `x` (l'Edge reconnaît l'utilisateur par le mot
     de passe) ;
   - **Mot de passe** : l'invité en lecture seule suffit ; sur un FEMS, son mot
     de passe est en général `user`. L'état le signale quand le mot de passe
     se connecte avec plus de droits ;
   - **Production** : « Suivi énergétique » (la production va au suivi
     énergétique sous forme d'index) ou « Capteur seulement » (une autre
     intégration envoie déjà cette production à Gladys). À choisir avant de
     créer l'appareil ;
   - **Intervalle de lecture** : 30 s par défaut (30 à 300).
3. Cliquez sur **Tester la connexion**, puis créez l'appareil depuis l'onglet
   **Découverte**.

## Comment il lit

Chaque lecture ouvre une connexion à l'Edge, se connecte, s'abonne aux
valeurs, prend les premières valeurs envoyées par l'Edge, et ferme. Une
connexion à la fois, jamais plus vite que l'intervalle : ni au bouton de test,
ni à la Découverte, ni à une reconnexion, ni après un redémarrage du conteneur
(il attend l'intervalle plus une minute après la dernière session). Une
nouvelle adresse ou un nouveau mot de passe est lu tout de suite.

- **Mot de passe refusé** (l'Edge répond « authentification échouée ») : les
  lectures s'arrêtent jusqu'à l'enregistrement d'un nouveau mot de passe ou un
  clic sur **Tester la connexion** (un essai par clic). Une connexion fermée,
  une absence de réponse ou une autre erreur n'est pas un refus : nouvel essai
  après 1 min, puis jusqu'à toutes les 15 min.
- **Identité** : les valeurs ne vont qu'à l'appareil du nom d'hôte lu dans la
  même session. Sans nom d'hôte lisible, rien n'est publié ; un autre nom
  d'hôte à la même adresse a son propre appareil.

## Compteurs à vie

Un compteur à vie ne fait que monter. Chaque compteur passe par une garde :

- 0, une valeur manquante ou un texte n'est jamais publié ;
- une **baisse** (remise à zéro, compteur remplacé) ou un **saut** de plus de
  100 kW en moyenne (plus 0,5 kWh) depuis la dernière valeur est **retenu** : la dernière
  valeur acceptée est renvoyée, l'état l'affiche, et le temps ne le confirme
  jamais ;
- s'il est juste, cliquez deux fois sur **Accepter le compteur retenu** (le
  premier clic liste, le second, de 3 s à 5 min plus tard, accepte exactement
  ce qui a été listé). Après une baisse acceptée, le comptage reprend à la
  nouvelle valeur ; le suivi énergétique ne compte rien pour la baisse.
  Enregistrer la configuration n'accepte rien.

## Confidentialité et sécurité

Le mot de passe est gardé par Gladys dans sa base, jamais réaffiché, envoyé
seulement à l'Edge sur votre réseau, dans la requête de connexion. Il n'est
jamais écrit dans les journaux, dans `/data` ni dans un état. Après un mot de
passe refusé, `/data` garde une empreinte salée de 8 bits (pour voir après un
redémarrage si le formulaire a changé), effacée à la connexion réussie
suivante. La connexion est un WebSocket simple sur votre réseau, comme celui
de la page web du FEMS.

## Limites

- Un Edge par intégration.
- Aucune commande : limites de charge, borne de recharge et réglages de l'Edge
  ne sont pas disponibles (peut-être plus tard, derrière une option).
- Les signes des puissances batterie et réseau sont ceux que documente
  OpenEMS ; pas encore vérifiés sur un vrai système.
