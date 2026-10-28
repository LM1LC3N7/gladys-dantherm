# Dantherm / Pluggit pour Gladys

Affiche une ventilation double flux **Dantherm** (HCV, RCV, HCH) ou
**Pluggit** (AP, iFlow) dans Gladys, par son interface **Modbus TCP** sur
votre réseau local, sans cloud ni compte. Intégration non officielle, **sans
lien avec Dantherm ni Pluggit**. **Jamais testé avec un vrai appareil** :
elle lit et écrit les registres de la table Modbus du fabricant (contrôleur
Pluggit, commun aux deux marques) tels que les utilise l’intégration libre
Dantherm de Home Assistant ; merci de signaler ce que vous constatez.

## Avant de commencer

- La centrale doit être sur votre réseau (Ethernet) et joignable depuis
  Gladys sur le **port 502** (Modbus TCP). Donnez-lui une adresse IP fixe
  dans votre routeur. Firmware conseillé : 2.70 ou 3.08 et suivants (ceux
  que l’intégration de Home Assistant demande).
- Le Modbus TCP n’a **pas de mot de passe** : gardez la centrale sur un
  réseau de confiance.
- L’identifiant d’unité Modbus (adresse esclave) vaut 1 sauf si vous l’avez
  changé.
- Le contrôleur accepte trois connexions à la fois. L’intégration n’en ouvre
  qu’une, et la ferme après chaque lecture.

## Installation

1. Installez l’intégration depuis le store de Gladys.
2. Saisissez l’**adresse IP de la centrale** (port 502 sauf si vous en
   ajoutez un) et, si besoin, l’identifiant d’unité Modbus ; enregistrez.
3. Ouvrez l’onglet **Découverte** et ajoutez la centrale.

## Ce que vous obtenez

Un appareil, **Ventilation Dantherm / Pluggit**, avec :

| Fonctionnalité                          | Remarques                                                                                                                                    |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Mode de ventilation                     | liste : automatique (à la demande), programme hebdomadaire, manuel niveau 1 à 4                                                              |
| Mode en cours                           | texte (clé stable en anglais) : `standby`, `manual`, `demand`, `week-program`, `away`, `summer`, `night`…                                    |
| Niveau de ventilation                   | 0 à 4 (0 : arrêtée)                                                                                                                          |
| Alarme                                  | texte : `none`, `exhaust-fan`, `supply-fan`, `bypass`, `overtemperature`, `fire`, `fire-protection`… ; `unknown-<code>` pour un code inconnu |
| Alarme active                           | 1 = une alarme est active                                                                                                                    |
| Volet de bypass                         | texte : `closed`, `in-progress`, `opening`, `closing`, `opened`                                                                              |
| Températures T1 à T4                    | extérieur, soufflage, extraction, rejet ; °C                                                                                                 |
| Température ambiante T5                 | seulement si la centrale déclare la sonde (composant HRC2)                                                                                   |
| Humidité                                | % ; seulement avec une sonde (0 n’est jamais publié)                                                                                         |
| Qualité de l’air (COV, équivalent CO2)  | ppm ; seulement avec une sonde COV (0 n’est jamais publié)                                                                                   |
| Filtres : jours restants                | jours                                                                                                                                        |
| Arrêter la ventilation                  | bouton                                                                                                                                       |
| Remettre à zéro le compteur des filtres | bouton                                                                                                                                       |

Les textes ne sont jamais publiés comme une mesure : une valeur inconnue ou
hors plage n’est pas publiée (Gladys garde la précédente).

La centrale est lue toutes les 60 s (réglable de 30 s à 1 h), en dix
requêtes sur une seule connexion, fermée ensuite. Le bouton de test, une
recherche dans Découverte, une reconnexion de Gladys ou un redémarrage de
l’intégration ne la relisent jamais avant l’intervalle. Lectures hors
intervalle :

- chaque commande relit la centrale juste avant d’écrire, puis relit ce
  qu’elle a écrit ;
- l’arrêt et ses renvois ;
- 5 s puis 20 s après une commande non confirmée et après chaque arrêt ;
- une nouvelle adresse ou un nouvel identifiant d’unité enregistré est lu
  aussitôt.

## Arrêter la ventilation

Le bouton **Arrêter la ventilation** met la centrale en mode manuel au
niveau 0 (ce que l’intégration de Home Assistant appelle la veille). Il lit
d’abord le mode en cours (1 s au plus ; relu sur la connexion suivante si la
lecture échoue) : un mode absence, été, cheminée ou nuit est d’abord quitté
(la sortie du mode nuit, 0x8020, reprend l’intégration de Home Assistant et
reste à vérifier sur un appareil). Puis il écrit le niveau 0, le mode
manuel, et de nouveau le niveau 0 : coupé après n’importe laquelle de ces
écritures, l’arrêt ne laisse jamais la centrale en manuel au niveau
mémorisé (jusqu’à 4).

Il n’est soumis à **aucune option**, ni à une autre commande en cours, ni à
une lecture en cours (il la coupe), ni à l’attente après une erreur, ni au
numéro de série, ni au fichier d’état de /data, ni à la configuration
envoyée par Gladys (la dernière centrale configurée est gardée dans /data).
Il annule une commande de mode pas encore envoyée ; une écriture plus
ancienne déjà partie qui s’appliquerait après lui est rattrapée par la
lecture qui suit (ci-dessous). Une connexion refusée ou fermée, une réponse
absente ou fausse, une exception Modbus autre que 1, 2 ou 3 (centrale en
défaut, occupée) sont réessayées toutes les 250 ms jusqu’à 3,5 s après
l’appui. Il est confirmé seulement quand la centrale relit la veille, ou le
mode manuel au niveau 0 : un niveau 0 lu dans un autre mode (automatique,
nuit, absence…) n’est pas un arrêt.

Il peut toutefois répondre sans avoir arrêté la ventilation dans ces cas :

- aucune adresse valide, ni dans la configuration, ni dans /data ;
- valeur reçue autre que 1 ;
- centrale injoignable jusqu’à 3,5 s après l’appui (« non envoyée », ou
  « pas encore envoyé » s’il essaie encore) ;
- réponse absente ou fausse jusqu’au bout, exception Modbus 1 à 3, ou
  centrale relue en marche (« envoyée, sans confirmation ») ; une centrale
  restée en forçage, installateur, sécurité ou dégivrage répond « la
  centrale reste en mode … » ; si le mode en cours n’a pas pu être lu à
  temps, la réponse le dit (absence, été, cheminée ou nuit n’ont alors pas
  été quittés).

Un deuxième appui pendant le premier le rejoint. L’arrêt est gardé dans
/data :

- **non confirmé**, il est renvoyé au démarrage suivant de l’intégration
  (avant toute lecture et même si Gladys ne répond pas) et par chaque
  lecture qui montre la centrale en marche, trois fois au plus ; ensuite le
  statut dit que l’arrêt n’a pas pris (ou que la centrale reste dans son
  mode) jusqu’au prochain appui ou à un mode choisi ;
- **confirmé**, il est renvoyé une fois, si la première lecture commencée
  après son écriture (5 s après) montre la centrale en marche (une écriture
  plus ancienne peut encore arriver). Une relance faite ensuite au panneau
  ou dans l’application n’est jamais combattue.

Cette garde **ne se lève jamais avec le temps**. Elle se lève seulement :

- par un mode choisi depuis Gladys avec l’option activée (juste avant son
  écriture ; remise si la centrale refuse cette écriture avec une exception
  1, 2 ou 3) ;
- après un arrêt confirmé, par deux lectures de suite qui montrent la
  centrale en marche alors qu’aucun renvoi n’est dû : la centrale a été
  relancée hors de Gladys (panneau, application) ; le statut le dit. Une
  lecture inconnue entre les deux remet le compte à zéro.

## Commandes en option

Le **mode** est refusé tant que **Autoriser les commandes de mode** n’est
pas activé, et la **remise à zéro des filtres** tant que **Autoriser la
remise à zéro des filtres** ne l’est pas (les deux désactivés par défaut).
Aucun interrupteur : un « éteins tout » d’un assistant vocal n’atteint
jamais la ventilation.

- Chaque commande relit la centrale juste avant d’écrire (numéro de série,
  mode en cours, niveau et alarme ; ou jours restants des filtres), n’écrit
  rien quand le mode est déjà le bon (sauf si un arrêt est gardé : il est
  alors écrit, ce qui lève la garde), et n’est confirmée que si la centrale
  répond à chaque écriture puis relit ce qui a été demandé (pour les
  filtres : des jours restants plus nombreux qu’avant ; autant qu’avant
  n’est pas une confirmation). Une commande qui a pu atteindre la centrale
  sans être confirmée répond « envoyée, sans confirmation » : vérifiez la
  centrale quelques secondes plus tard. Une première écriture refusée avec
  une exception Modbus 1, 2 ou 3 répond « refusée » et n’est pas appliquée ;
  les autres exceptions répondent « envoyée, sans confirmation ». Une
  commande dont la première écriture ne peut pas partir dans les 3,5 s est
  refusée et rien n’est envoyé.
- Un mode choisi peut **relancer une centrale arrêtée** : c’est pour cela
  qu’il dépend de l’option. Il est refusé pendant un arrêt en cours.
- Le mode est refusé quand la centrale est dans un mode que Gladys ne règle
  pas : absence, été, cheminée, nuit, forçage par entrée externe ou par
  l’hygrostat, installateur, sécurité, arrêt sur défaut, dégivrage. Changez
  ce mode sur la centrale ou dans son application.
- Le mode est refusé en **alarme incendie, surchauffe ou inconnue** (codes
  12, 14, 16 et tout code hors de la liste : `overtemperature`, `fire`,
  `fire-protection`, `unknown-<code>`). Les noms des codes suivent
  l’intégration de Home Assistant ; la table de 2013 nomme autrement les
  codes 12 à 15, d’où les trois codes refusés.
  Un registre d’alarme non rempli (0xFFFFFFFF) se lit `unknown-4294967295` :
  alarme active et mode refusé, du côté sûr.
- **Numéro de série** : l’intégration retient une empreinte salée du numéro
  de série de la centrale (jamais le numéro lui-même). Si un autre numéro
  est lu (centrale remplacée, ou autre appareil à la même adresse), ses
  valeurs ne sont pas affichées, le statut l’indique et les commandes en
  option sont refusées jusqu’à un appui sur **Tester la connexion**, qui
  accepte la centrale. Un numéro illisible ne vaut pas « autre centrale ».
  L’arrêt n’en dépend pas.
- Si le fichier d’état de /data est illisible, il n’est jamais écrasé et
  les commandes en option sont refusées (pas l’arrêt). Une commande est
  aussi refusée si l’empreinte apprise n’a pas pu être écrite dans /data.

## Statut et erreurs

Le statut de l’intégration indique le mode en cours, le niveau, une alarme,
le type de centrale et son firmware, une centrale injoignable (avec le
prochain essai : 30 s, 1, 2 puis 5 min, jamais moins que l’intervalle), un
arrêt non confirmé, une relance hors de Gladys, une configuration que
Gladys n’a pas pu donner (nouvel essai à 5 s, doublé jusqu’à 5 min, sans
fin ; les lectures continuent avec la configuration en cours). Une
requête refusée par la centrale (exception Modbus) laisse ses valeurs
inconnues ; une mesure toujours refusée ou muette n’est relue qu’une fois
par heure.

## Limites

- Jamais testé avec un vrai appareil.
- Le type de centrale est affiché par son numéro (les tables de Dantherm et
  de Pluggit donnent des noms différents au même numéro).
- La table du fabricant (2013) place le type de centrale dans l’octet de
  poids faible de `prmSystemID` ; l’intégration de Home Assistant, utilisée
  sur les firmwares actuels, le lit dans l’octet de poids fort : c’est
  cette lecture qui est retenue. Le type ne sert qu’à l’affichage.
- Pas encore : réglages du bypass, de l’humidité, du programme hebdomadaire,
  remise à zéro des alarmes, vitesses des ventilateurs, heures de
  fonctionnement.
